import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BRIDGE = "br-3a38698ddffe";
const TRAEFIK_IP = "172.18.0.2";
const TRAEFIK_ID = "/n8n-traefik-1";

function check(ok, reason) {
  if (!ok) throw new Error(`Beget OAuth NAT inventory: ${reason}`);
}

function rules(output, family) {
  check(typeof output === "string" && output.includes("*nat\n") &&
    output.includes("\nCOMMIT"), `incomplete ${family} NAT table`);
  const lines = output.split("\n").filter(line => line.startsWith("-A "));
  check(lines.length > 0, `empty ${family} NAT rules`);
  return lines;
}

// iptables-nft and the older xtables backend can coexist. Inspect the
// complete legacy-save output, not only its NAT table: mangle TPROXY or a
// filter redirect could otherwise bypass the nft-based inventory.
export function validateBegetLegacyIptables(ipv4, ipv6) {
  for (const [family, output] of [["IPv4", ipv4], ["IPv6", ipv6]]) {
    check(typeof output === "string", `missing ${family} legacy iptables inventory`);
    const meaningful = output.split("\n").map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));
    let inTable = false;
    for (const line of meaningful) {
      if (/^\*[a-z]+$/.test(line)) {
        check(!inTable, `${family} legacy iptables has an incomplete table`);
        inTable = true;
      } else if (/^:[A-Za-z0-9_-]+ (?:ACCEPT|DROP|-) \[\d+:\d+\]$/.test(line)) {
        check(inTable, `${family} legacy iptables has an incomplete table`);
      } else if (line === "COMMIT") {
        check(inTable, `${family} legacy iptables has an incomplete table`);
        inTable = false;
      } else check(false, `${family} legacy iptables contains a rule`);
    }
    check(!inTable, `${family} legacy iptables has an incomplete table`);
  }
  return true;
}

export async function inspectBegetLegacyBackends({ stat = lstat, run = exec } = {}) {
  const options = { timeout: 12000, maxBuffer: 4 * 1024 * 1024 };
  const legacy = async (family, binary) => {
    try { await stat(`/proc/net/${family}_tables_names`); }
    catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
    return (await run(binary, ["-M", "/bin/false"], options)).stdout;
  };
  const legacy4 = await legacy("ip", "iptables-legacy-save");
  const legacy6 = await legacy("ip6", "ip6tables-legacy-save");
  validateBegetLegacyIptables(legacy4, legacy6);
  return true;
}

// Fail closed on any added NAT rule, including another published port,
// alternate redirect, or a changed bridge. Docker's two loopback-only
// publishers may change container addresses without changing this boundary.
export function validateBegetOAuthNatSnapshot(ipv4, ipv6, nft, traefik) {
  check(traefik?.Name === TRAEFIK_ID && traefik.State?.Running === true &&
    /^[0-9a-f]{64}$/.test(traefik.Id || ""), "missing running Traefik identity");
  const network = Object.values(traefik.NetworkSettings?.Networks || {}).filter(item =>
    item?.IPAddress === TRAEFIK_IP && item.NetworkID?.startsWith(BRIDGE.slice(3)));
  check(network.length === 1, "NAT target is not the running Traefik network address");

  const v4 = rules(ipv4, "IPv4");
  const expected = [
    "-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER",
    "-A OUTPUT ! -d 127.0.0.0/8 -m addrtype --dst-type LOCAL -j DOCKER",
    "-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE",
    `-A POSTROUTING -s 172.18.0.0/16 ! -o ${BRIDGE} -j MASQUERADE`,
    "-A DOCKER -i docker0 -j RETURN",
    `-A DOCKER -i ${BRIDGE} -j RETURN`,
    ...[5432, 5678].map(port => new RegExp(
      `^-A DOCKER -d 127\\.0\\.0\\.1/32 ! -i ${BRIDGE} -p tcp -m tcp --dport ${port} -j DNAT --to-destination 172\\.18\\.0\\.[1-9][0-9]*:${port}$`)),
    ...[80, 443].map(port =>
      `-A DOCKER ! -i ${BRIDGE} -p tcp -m tcp --dport ${port} -j DNAT --to-destination ${TRAEFIK_IP}:${port}`)
  ];
  check(v4.length === expected.length && expected.every((item, index) =>
    item instanceof RegExp ? item.test(v4[index]) : item === v4[index]),
  "IPv4 NAT rules changed or contain an alternate forward");
  const v6 = rules(ipv6, "IPv6");
  check(JSON.stringify(v6) === JSON.stringify([
    "-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER",
    "-A OUTPUT ! -d ::1/128 -m addrtype --dst-type LOCAL -j DOCKER"
  ]), "IPv6 NAT rules changed");

  // iptables-save cannot see independent nftables rules. The captured host
  // has five tables; new tables and any nft-native redirect need an audit.
  check(typeof nft === "string" && nft.length > 0, "missing nft ruleset");
  const tables = [...nft.matchAll(/^table (\S+) (\S+) \{/gm)]
    .map(([, family, name]) => `${family} ${name}`);
  check(JSON.stringify(tables) === JSON.stringify([
    "ip nat", "ip filter", "ip6 nat", "ip6 filter", "ip raw"
  ]), "nft table inventory changed");
  check(!/\b(?:redirect|tproxy)\b/i.test(nft), "nft ruleset contains a redirect");
  const destinations = [...nft.matchAll(/\bdnat to (\S+)/g)].map(match => match[1]);
  const loopbackTargets = v4.slice(6, 8).map(rule =>
    rule.match(/--to-destination (\S+)$/)?.[1]);
  check(destinations.length === 4 &&
    destinations[0] === loopbackTargets[0] &&
    destinations[1] === loopbackTargets[1] &&
    destinations[2] === `${TRAEFIK_IP}:80` &&
    destinations[3] === `${TRAEFIK_IP}:443`, "nft destination inventory differs");
  return { traefikContainerId: traefik.Id, ipv4Target: TRAEFIK_IP,
    ipv4PublicPorts: [80, 443], ipv6Dnat: false, loopbackTargets,
    scope: "pinned Docker NAT and nft destination inventory only" };
}

// Root-only, read-only. This inventory is a component of the route boundary;
// it does not establish upstream response identity or all external ingress.
export async function inspectBegetOAuthNat() {
  check(process.getuid?.() === 0, "root is required");
  const options = { timeout: 12000, maxBuffer: 4 * 1024 * 1024 };
  const { stdout: before } = await exec("docker", ["inspect", "n8n-traefik-1"], options);
  const containers = JSON.parse(before);
  check(Array.isArray(containers) && containers.length === 1, "incomplete Traefik inspection");
  const { stdout: v4 } = await exec("iptables-save", ["-t", "nat"], options);
  const { stdout: v6 } = await exec("ip6tables-save", ["-t", "nat"], options);
  const { stdout: nft } = await exec("nft", ["-a", "list", "ruleset"], options);
  // The legacy save binaries otherwise attempt modprobe on an uninitialized
  // table. An absent proc table list is never initialized just to inspect.
  await inspectBegetLegacyBackends();
  const result = validateBegetOAuthNatSnapshot(v4, v6, nft, containers[0]);
  const { stdout: after } = await exec("docker", ["inspect", "n8n-traefik-1"], options);
  const final = JSON.parse(after);
  check(Array.isArray(final) && final.length === 1 &&
    final[0].Id === result.traefikContainerId &&
    JSON.stringify(final[0].NetworkSettings?.Networks) ===
      JSON.stringify(containers[0].NetworkSettings?.Networks),
  "Traefik network changed while inspecting NAT");
  return result;
}
