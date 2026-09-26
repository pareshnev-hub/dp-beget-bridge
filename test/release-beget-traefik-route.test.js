import test from "node:test";
import assert from "node:assert/strict";
import { BEGET_OAUTH_ROUTE_SHA256, validateBegetTraefikSnapshot } from
  "../scripts/release/inspect-beget-traefik-route.mjs";

function fixture() {
  const traefik = { Name: "/n8n-traefik-1", State: { Running: true },
    Args: ["--providers.docker=true", "--providers.docker.exposedbydefault=false",
      "--providers.file.directory=/dynamic", "--providers.file.watch=true"],
    Config: { Env: [] },
    Mounts: [{ Type: "bind", Source: "/opt/beget/n8n/traefik_dynamic", Destination: "/dynamic" }],
    HostConfig: { NetworkMode: "bridge" } };
  const unrelated = { Name: "/n8n-n8n-1", State: { Running: true },
    HostConfig: { NetworkMode: "bridge" }, Config: { Labels: { "traefik.enable": "true",
      "traefik.http.routers.n8n.rule": "Host(`crarojofimo.beget.app`)",
      "traefik.http.routers.n8n.service": "n8n" } } };
  const oauthUnpublished = { Name: "/oauth-app", State: { Running: true },
    HostConfig: { NetworkMode: "bridge" }, Config: { Labels: {} } };
  return { traefik, containers: [traefik, unrelated, oauthUnpublished] };
}

test("OPS-07: pinned Beget route snapshot accepts only an unrelated Docker host", () => {
  const { traefik, containers } = fixture();
  assert.equal(validateBegetTraefikSnapshot(traefik, containers), 1);
  assert.equal(BEGET_OAUTH_ROUTE_SHA256,
    "eeeec8b6c30fc69ca296957c55274aed9224dae804c1f3a57d826569bc8bd37b");
  containers[1].Config.Labels["traefik.http.routers.n8n.rule"] =
    "Host(`crarojofimo.beget.app`) && (Path(`/ymc`) || PathPrefix(`/ymc/`))";
  assert.equal(validateBegetTraefikSnapshot(traefik, containers), 1);
  containers[1].Config.Labels["traefik.http.routers.n8n.tls.certresolver"] = "mytlschallenge";
  assert.equal(validateBegetTraefikSnapshot(traefik, containers), 1);
  for (const property of ["entrypoints", "middlewares", "priority", "tls"]) {
    containers[1].Config.Labels[`traefik.http.routers.n8n.${property}`] = "observed";
  }
  assert.equal(validateBegetTraefikSnapshot(traefik, containers), 1);
});

test("OPS-07: missing or changed live provider/mount refuses route snapshot", () => {
  for (const mutate of [
    f => f.traefik.Args.push("--providers.file.filename=/extra.yml"),
    f => f.traefik.Args.push("--providers.consul=true"),
    f => f.traefik.Args[1] = "--providers.docker.exposedbydefault=true",
    f => f.traefik.Args[2] = "--providers.file.directory=/wrong",
    f => f.traefik.Args.push("--configFile=/extra.yml"),
    f => f.traefik.Mounts[0].Source = "/wrong",
    f => f.traefik.Config.Env.push("TRAEFIK_PROVIDERS_FILE_FILENAME=/extra.yml"),
    f => f.traefik.State.Running = false
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => validateBegetTraefikSnapshot(f.traefik, f.containers), /topology/);
  }
});

test("OPS-07: conflicting, default, wildcard and case-duplicate Docker routes fail closed", () => {
  for (const mutate of [
    labels => { labels["traefik.http.routers.n8n.rule"] = "Host(`bridge-oauth.pareshnev.com`)"; },
    labels => { labels["traefik.http.routers.n8n.rule"] = "HostRegexp(`{host:.+}`)"; },
    labels => { labels["traefik.http.routers.n8n.rule"] += " || Host(`bridge-oauth.pareshnev.com`)"; },
    labels => { delete labels["traefik.http.routers.n8n.rule"]; },
    labels => { labels["traefik.http.routers.other.service"] = "n8n"; },
    labels => { labels["traefik.http.routers.other.tls.certresolver"] = "mytlschallenge"; },
    labels => { labels["traefik.http.routers..rule"] = "Host(`crarojofimo.beget.app`)"; },
    labels => { labels["traefik.http.routers.n8n.tls.domains[0].main"] = "unknown"; },
    labels => { labels["traefik.tcp.routers.other.rule"] = "HostSNI(`*`)"; },
    labels => { labels["Traefik.Enable"] = "false"; }
  ]) {
    const f = fixture();
    mutate(f.containers[1].Config.Labels);
    assert.throws(() => validateBegetTraefikSnapshot(f.traefik, f.containers), /topology/);
  }
  const f = fixture();
  f.containers[2].Config.Labels["traefik.enable"] = "true";
  assert.throws(() => validateBegetTraefikSnapshot(f.traefik, f.containers), /default router rule/);
});
