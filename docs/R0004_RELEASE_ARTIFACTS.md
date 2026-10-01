# R0004 release artifact trust — first implementation slice

Status: **CANDIDATE BUILD/SIGN/VERIFY AND ROOT-OWNED PREPARATION IMPLEMENTED; INSTALLER ENFORCEMENT PENDING**. This does not install, update, publish, or activate a release.

`scripts/release/verify-artifact.mjs` checks a detached Ed25519 signature over the **exact bytes** of a small JSON manifest, then streams the named archive and checks its signed size and SHA-256 digest. The release manifest format is:

```json
{
  "format": "dp-beget-bridge-release-v1",
  "version": "1.0.0",
  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "artifact": {
    "name": "dp-beget-bridge-1.0.0.tar.gz",
    "size": 12345,
    "sha256": "<64 lowercase hex characters>"
  }
}
```

The values shown are illustrative. The signature file contains canonical Base64 of the raw 64-byte Ed25519 signature, optionally followed by a newline. The key is an Ed25519 SPKI PEM public key. The verifier never accepts a key from the manifest or an archive and does not follow symlinks for its four inputs.

Build an unsigned candidate from an exact, committed SHA into a **new** directory. The builder reads `package.json` from that commit, uses `git archive`, writes a deterministic gzip stream with zero gzip timestamp, and records the archive size and SHA-256 in `manifest.json`. Uncommitted files and `node_modules` are not included. Reproducibility is tested on the supported CI toolchain; a different Git/zlib toolchain may produce different compressed bytes. Release identity is the recorded digest, not an expectation that all toolchains emit identical bytes.

```bash
node scripts/release/build-artifact.mjs --commit <full-40-character-commit-sha> --output-dir /new/private/candidate-directory
```

The release signer receives a private Ed25519 PKCS#8 PEM key from the operator's separate key custody path. It requires a private regular file (mode `0600`), checks the local candidate bytes against the manifest before signing, and creates a new detached signature file without replacing an existing file. Key generation, key distribution, rotation and CI custody are **not** automated or accepted yet.

```bash
node scripts/release/sign-manifest.mjs --artifact /candidate/dp-beget-bridge-1.0.0.tar.gz --manifest /candidate/manifest.json --private-key /separate/private-key.pem --signature /candidate/manifest.sig
```

Local verification of an independently acquired candidate:

```bash
node scripts/release/verify-artifact.mjs --artifact dp-beget-bridge-1.0.0.tar.gz --manifest manifest.json --signature manifest.sig --trusted-key /path/to/independently-trusted-release-key.pem
```

An independent staging utility copies a verified candidate into a newly created private directory, then verifies the copied bytes again. Source-path substitution between the two checks cannot make unverified staged bytes pass. It performs no archive extraction, execution, service change or migration:

```bash
node scripts/release/stage-verified-artifact.mjs --artifact /candidate/dp-beget-bridge-1.0.0.tar.gz --manifest /candidate/manifest.json --signature /candidate/manifest.sig --trusted-key /separate/pinned-release-key.pem --stage-dir /new/private/stage-directory
```

A separate quarantine extractor verifies the signed archive again, checks the exact compressed bytes it will parse, and admits only the `git archive` release layout with regular files and directories below the versioned root. Symlinks, hardlinks, special entries, traversal, duplicate paths and unsupported tar extensions are rejected before any extraction. The private destination is created only after validation. Compressed input is capped at 64 MiB and expanded tar at 256 MiB; the resulting files are mode `0600` and directories `0700` until a future installer applies its runtime ownership policy.

```bash
node scripts/release/extract-verified-artifact.mjs --artifact /stage/dp-beget-bridge-1.0.0.tar.gz --manifest /stage/manifest.json --signature /stage/manifest.sig --trusted-key /separate/pinned-release-key.pem --output-dir /new/private/extraction-directory
```

**Trust boundary:** the public key must be obtained through a separate authenticated channel and pinned by a future installer; placing an untrusted key beside the archive proves nothing. The future installer must consume **only** the verified staged bytes, preflight migrations and switch versions without destroying live Session Host state. Verification, staging and quarantine extraction never execute archive content or alter the running service.

The root-only one-time trust bootstrap now accepts a public Ed25519 SPKI PEM acquired separately from the release candidate and its independently verified SHA-256 fingerprint. It creates `/etc/dp-beget-bridge/release-trust/ed25519-public.pem` in a root-owned, non-writable-by-others directory and refuses replacement. The operator must obtain the key and fingerprint independently; this repository does not contain the production key or decide key custody and rotation. The executable bootstrap itself must come from a trusted installation source, never from an unverified candidate.

```bash
node scripts/release/pin-release-key.mjs --source /independent/public.pem --sha256 <independently-verified-64-hex-fingerprint>
```

The root-only preparation step uses this pinned key, verifies the candidate **before** creating its workspace, and then re-verifies private staged and extracted bytes. It checks the signed package and lockfile version, rejects missing or malformed state compatibility records before dependency installation, runs `npm ci --omit=dev --ignore-scripts` with isolated private cache and configuration, rejects dependency symlinks outside the extracted tree and removes the cache. A CI root job also exercises the real dependency installation. Its output is a mode `0700` quarantine directory, **not** a service-ready release directory: runtime ownership, migration, admission freeze, activation and rollback remain to be implemented.

After signature verification and before creating the workspace, preparation checks available bytes on its parent filesystem. It reserves the signed archive size, the 256 MiB extraction ceiling, 1 GiB each for the installed dependencies and private npm cache, and 512 MiB free afterward. The npm allocations are estimates rather than enforced ceilings; a release rehearsal must measure the actual candidate and ensure the separate grouped state snapshot budget is also available on the shared volume. The candidate input files are already present and are not counted as new writes.

The `prepareRelease` API additionally accepts `migration: { snapshotParent, databases }` for a first migration on a shared filesystem. Before creating its workspace, this path verifies that both parent directories are on the same device, sizes the declared SQLite files and existing sidecars, then requires the **sum** of candidate and grouped snapshot allowances to fit the lower of two capacity readings. It conservatively counts each phase's 512 MiB free reserve. The standalone `prepare-release` CLI does not accept a migration inventory; a future migration controller must supply and repeat the combined check with the exact candidate, data paths and current filesystem state. A missing or outdated database inventory cannot be treated as migration approval.

```bash
node scripts/release/prepare-release.mjs --artifact /candidate/dp-beget-bridge-1.0.0.tar.gz --manifest /candidate/manifest.json --signature /candidate/manifest.sig --workspace /new/private/release-workspace
```

Next slices: approved release-key custody and rotation policy; verified public installer bootstrap; atomic staged install/update with migration backups, health-gated activation and rollback; clean-host and failed-update integration evidence. OPS-05 is only partially implemented until the installer consumes pinned-key-prepared bytes and tests rejection of a bad signature/checksum on supported hosts.

The read-only R0004 host preflight is separate from the existing technical-preview installer. It currently supports **Ubuntu 24.04 LTS with a preconfigured HTTPS reverse proxy and a single public A record**. It checks a non-root work identity, an absolute real allowed-root directory, Node 22+, host dependencies, exact DNS→VPS IPv4 mapping and a certificate validated for the hostname using SNI. DNS and TLS checks have explicit five-second deadlines. It does not mutate system configuration or install software:

```bash
node scripts/release/host-preflight.mjs --domain bridge.example.com --expected-ip 1.1.1.1 --work-user dp-preview --allowed-root /srv/dp-preview-workspace
```

The IP and hostname above are examples. A setup wizard must make these prerequisites actionable and choose the supported proxy coexistence path before OPS-01…04 can be accepted. The first-time bootstrap may need a different order for DNS/TLS provisioning; this preflight defines the already-routed profile only.

`scripts/release/preflight-clean-install.mjs` now composes the pinned signed candidate, existing host prerequisites, release preparation space budget and a twice-checked inventory of the seven reserved unit names and their on-disk fragments/drop-ins, legacy code/config/data/runtime paths and Direct TCP listeners on ports 8787 and 8788. It fails closed if the listener inventory reports an error, even when `ss` exits successfully. It requires the prospective version root to be absent. This is a read-only first-install gate for a clean, **already routed** host; it does not inspect the actual reverse-proxy route, create identities, configure units, install a release or authorize public exposure. An installer must separately prove coexistence and complete the stopped-service/recovery transaction before OPS-01/02 can pass.

The same gate now checks that the selected existing work account owns a private work directory, its primary group matches the requested group, and the two new service names and IPC group are unused. These are repeated before candidate preparation to catch a changed identity inventory. The CLI requires explicit `--work-group`, `--agent-user`, `--mcp-user` and `--ipc-group` arguments alongside the previous inputs. This remains a point-in-time inspection; the installer must create and verify accounts under a recovery transaction before loading any service.

`stageCleanInstallUnits` is an internal, root-only clean-install primitive. It rechecks the independently pinned signature, reads the three core Direct service templates from the exact signed archive bytes, validates distinct non-root service names and unambiguous systemd paths, then creates rendered units in a new private `0700` directory as `0600` files. The working directory points to the managed `current` link and Session Host keeps `KillMode=process`. It does not load units, create identities or configuration, switch a release, enable ingress or establish rollback. Its caller must journal and verify those steps before public exposure.

`stageCleanInstallConfig` creates the three core Direct environment files in a separate private directory. It generates independent random Agent and MCP tokens, keeps all credentials out of Session Host's environment and disables telemetry by default. It never prints or returns secrets. The future installer must verify the service identities and atomically install these files with the correct group ownership, start services behind a closed ingress, and record a recovery path; staging alone is not a clean installation.

`prepareCleanInstall` combines the read-only clean-host gate, root-owned signed candidate preparation and private Direct unit/config staging in one call. It binds the preflight, prepared tree and signed template bytes to the same archive SHA-256. A staging failure removes only the workspace it successfully created; a pre-existing workspace survives a rejected retry. It does not promote the release or write outside the new workspace. The actual installer still needs an ownership-safe service configuration transaction, recovery journal, route check, readiness proof and public exposure gate.

The prepared candidate now includes a private `candidate-manifest.json` that records the exact six staged unit/config names, sizes and SHA-256 digests, plus the signed release identity. `verifyCleanInstallManifest` requires the separately retained manifest digest, re-verifies the staged signed archive and rejects changed, missing, extra or unsafe staged files. This binds private preparation to a future install journal without exposing tokens in the manifest. The installer must still check bytes as it copies them to their live locations; an earlier verification alone does not prevent a later file replacement.

`startCleanInstallJournal` writes a new synced root-only journal outside the candidate workspace after re-verifying that bound manifest. The journal holds the release identity and an opaque transaction ID; `advanceCleanInstallJournal` takes a persistent exclusive lock and can record only the first `identities-intent` boundary before any account mutation. A changed candidate leaves the journal and lock for deliberate inspection. No `identities-ready`, installed-files or exposed phase can be claimed yet: these transitions need actual account, filesystem, service and route proofs wired into the installer. This journal is not itself an installer or a recovery controller.

The clean-install journal now derives its non-secret work/service identities, IPC group, allowed root, release root and public domain from the six bound staged files. It requires the three systemd units and the Agent/Session Host environments to agree and checks the candidate again after parsing. These values are recorded in the journal so the future account and file transaction can use one fixed plan; the random service tokens remain only in private environment files.

`installCleanIdentities` is the first live filesystem mutation behind the journaled `identities-intent` phase. It rechecks unused service names and the work directory, holds a separate synced exclusive lock, creates the IPC, Agent and MCP groups and two non-login service users, then checks exact group IDs, separate user IDs, fixed homes and a transaction-specific account comment before allowing `identities-ready`. It does not alter the existing work user's group membership. A failed or interrupted account command leaves the identity-install lock and the journal at `identities-intent`; no automatic retry adopts partially created names. Disposable CI now runs the actual account commands and verifies the resulting NSS records. After confirming the original installer stopped, `recoverCompletedCleanIdentities` can advance an interrupted journal only if all five identities exactly match its signed plan and transaction marker, or remove a remaining lock after an already recorded `identities-ready` phase. Partial identities stay locked for manual investigation. The clean installer still needs an end-to-end transaction and service installation before OPS-01 can pass.

The next `config-intent` phase requires verified service identities and no unresolved identity-install lock. `installCleanConfig` writes three manifest-bound environment files into a new root-owned directory with exact private modes and group ownership; `config-ready` requires an independent byte and ownership check. The preflight now reserves the entire `/etc/dp-beget-bridge` directory. Interrupted copies retain a separate lock for manual inspection. These files remain inert until journaled unit and release activation; no live Beget configuration is changed by this implementation slice.

After confirming the original installer stopped, `recoverCompletedCleanConfig` may complete `config-intent` only when the entire destination inventory, bytes, modes and service group ownership still match the signed candidate and transaction. It also removes a leftover install lock after an already recorded `config-ready` phase under the same checks. Missing, partial, or altered files remain locked; recovery never fills gaps or overwrites destinations automatically.

`units-intent` requires the installed private configuration, verified service identities, no unresolved configuration lock and still unoccupied systemd unit targets. `installCleanUnits` creates only the three signed Direct unit fragments as root-owned mode `0644` files and records `units-ready` after independent byte and fragment checks. It does not call `daemon-reload`, enable or start services. A partial write leaves its lock; recovery and service activation are still required. The four other reserved unit names and all seven drop-in directories must remain absent.

After the original installer has stopped, `recoverCompletedCleanUnits` can complete an interrupted `units-intent` only when the signed source, private configuration, identities and all three installed fragments still match; it can also remove a leftover lock after an already recorded `units-ready`. Partial or altered fragments remain locked. This recovery does not inspect service activity or activate anything; the next boundary must prove inactive services separately.

`data-intent` requires verified accounts, configuration and unit fragments with no unresolved unit-install lock, plus three absent data paths. `installCleanData` creates root-controlled private Session Host, Agent and MCP state directories under `/var/lib` with their distinct owner IDs and a private empty tmux subdirectory; `data-ready` requires an independent ownership, mode and inventory check. A partial creation remains locked. None of these steps starts a service, migrates a database or creates a public route.

After the original installer stops, `recoverCompletedCleanData` can finish an interrupted journal only when the signed candidate, identities, configuration, unit fragments and all four empty state directories still match. It can clear a leftover lock at `data-ready` under the same proof. An extra file, partial directory set, changed ownership or altered source leaves the lock in place for manual investigation.

`release-root-intent` requires all earlier private inputs and no unresolved data-install lock. `installCleanReleaseRoot` creates the previously absent root-owned version directory with an empty `releases` child and records `release-root-ready` after verifying both paths and inventory. A partial creation stays locked. The signed candidate remains in its private workspace; promotion, version-pointer creation, service startup and public ingress are later boundaries.

After the original installer stops, `recoverCompletedCleanReleaseRoot` can complete an interrupted `release-root-intent` or clear a leftover install lock at `release-root-ready` only when the signed candidate, account identities, configuration, units, data directories and empty version root all pass inspection. Unexpected files or a partial root remain locked.

`inspectPromotedCleanRelease` is a read-only proof for the later signed promotion boundary. It verifies the pinned archive and prepared candidate, compares every promoted source file to the signed archive, rejects unsigned source entries and unsafe ownership or modes, checks the dependency tree remains within the release, and requires exactly one inert version directory without a `current` pointer. It does not promote or activate the release.

`promotion-intent` requires the verified empty version root and no unresolved root-install lock. `promoteCleanInstall` then rechecks the signed candidate and prior installed inputs, moves the exact prepared tree through the existing signed promotion primitive, verifies the inert destination, and records `promotion-ready`. A failure after the move begins retains the lock for deliberate recovery. It does not create `current`, reload systemd or expose ingress.

After the installer has stopped, `recoverCompletedCleanPromotion` may adopt an interrupted move only if the journal lock matches its transaction, every prior installed input still verifies, the entire destination matches the signed archive, and the extracted source is gone. It accepts an empty, root-owned primitive lock left by an interrupted move, removes it, then verifies the destination again before advancing the journal. Partial or modified trees remain locked; recovery never creates `current` or starts a service.

The promoted-release inspector can also require a `current` symlink that points exactly to the single signed version directory. This is the read-only proof needed for a later journaled pointer transition; an absent, altered or additional pointer fails verification.

`pointer-intent` requires the signed inert release and no unresolved promotion lock. `installCleanPointer` then rechecks the staged identity plan, installed inputs and signed destination, creates the initial `current` symlink to that exact version, syncs the root and records `pointer-ready` only after verifying the link and release. Interruption after link creation retains a transaction lock for separate recovery. This step does not reload or start services or open ingress.

Once the original installer has stopped, `recoverCompletedCleanPointer` adopts a completed link only after checking the transaction lock, staged candidate, installed inputs, signed release and exact sole `current` symlink. Missing or changed pointers keep the transaction locked. Recovery does not activate a service.

`inspectCleanSystemdBoundary` is a read-only local gate after `daemon-reload`: it requires the three exact installed core unit files and signed `current` pointer, confirms systemd loaded those units with the expected service users and working directory but has not enabled or started them, checks the four reserved ingress unit names remain absent and inactive, and verifies Direct ports are unoccupied. It reports public ingress as unproven; an independent reverse-proxy route proof is still required before startup.

`systemd-intent` requires the verified `current` pointer and no unresolved pointer-install lock. `loadCleanSystemdUnits` rechecks the installed files, pointer, inactive seven-unit inventory and free Direct ports, durably locks the transaction, calls `systemctl daemon-reload`, then requires the loaded inactive binding before recording `systemd-ready`. A failure after reload begins retains the lock for deliberate recovery. It does not enable or start a service, configure a proxy, or claim public route safety.

After the original installer has stopped, `recoverCompletedCleanSystemd` can complete an interrupted reload only when the transaction lock matches, all staged and installed inputs still verify, and the loaded manager has the exact expected units inactive. An active or altered unit retains the lock. Recovery never starts a service.

Disposable CI also loads the three exact clean-install unit names into a real systemd manager, verifies they remain disabled and inactive with the expected identities and working directory, and rejects an added drop-in. This tests the loaded-manager parser independently of the signed workspace fixture; it does not start the application or prove public routing.

`admission-intent` requires the loaded inactive manager, a missing admission flag and no unresolved systemd-install lock. `installCleanAdmissionPause` then durably locks the transaction, creates the root-owned persistent flag consumed by the three core HTTP services, verifies it and records `admission-ready`. If the flag was unexpectedly present or the journal write fails after creation, the lock and pause remain in place for deliberate recovery. This keeps application requests denied before a future service start; route configuration and local health are still separate gates.

`recoverCompletedCleanAdmission` can adopt an interrupted completed pause after the original installer has stopped only when the lock matches its transaction, every signed and installed input still verifies, systemd remains inactive, and the persistent flag has the exact trusted content. A missing or altered flag stays locked; recovery never resumes admission.

After `admission-ready`, the journal can record `startup-intent` only with the exact persistent pause, inactive loaded units, signed installed inputs and an independently supplied `closed-exclusive` public route proof. The clean local startup API repeats these checks before starting Session Host, Agent and MCP in order, then requires the three loaded active bindings, exactly one listener each on `127.0.0.1:8787` and `127.0.0.1:8788`, and paused local health before recording `startup-ready`. On a start or health failure it stops attempted units in reverse order and leaves the startup lock for deliberate recovery. The default route verifier rejects every startup because the supported clean-host reverse-proxy proof is not implemented yet; CI supplies a disposable route fixture. This does not authorize public exposure, service enablement or Beget production mutation.

`recoverCleanLocalStartup` runs only after the original installer has stopped. It accepts the transaction lock, rejects an unresolved journal transition lock, and rechecks the signed candidate, installed state, exact pause and closed-route proof. A wholly inactive `startup-intent` can have its lock cleared for an explicit retry; a wholly active, locally healthy attempt can be adopted as `startup-ready`. A partial manager, failed health, altered gate or route, and an inactive `startup-ready` remain locked for manual investigation. Recovery never starts services or opens admission.

Disposable root CI also runs the startup and failed-second-start rollback against three actual disabled systemd units under separate non-root dummy identities. That fixture injects the signed candidate, pause, route and health evidence; it proves manager start/stop ordering and journal recovery, not the production reverse-proxy configuration or application health.

A separate disposable Linux CI test exercises the production `ss` reader with actual TCP sockets on both reserved Direct ports. It checks absent and partial listeners, accepts the complete IPv4 loopback pair, rejects a wildcard listener, and verifies the ports are free after cleanup. Enable it only on a disposable runner with `DP_TEST_REAL_LISTENERS=1`. This proves listener inventory behavior, not service ownership, proxy route closure or application health; the systemd transaction fixture still injects its listener report.

`probeCleanPublicRoute({ domain, expectedIp })` supplies a read-only public-response observation for a prospective clean installation. It validates the domain and public IPv4, verifies exclusive DNS and hostname-valid TLS before and after a fixed HTTPS `GET /mcp`, pins the connection to that IP and uses the domain for both SNI and Host. The request sends no credentials, follows no redirects, limits headers to 8 KiB and body to 4 KiB, and enforces an 8-second total deadline including TLS and body delivery. It accepts only a bounded 502 without redirect or authentication headers. Network errors are reported without remote error text or response bodies.

The result deliberately reports `publicResponse: closed-upstream` and `publicIngress: unproven`. A 502 could originate from a wrong upstream or unrelated proxy; it cannot prove route exclusivity. This API is not wired as `inspectClosedIngress`, and the default startup gate remains closed. A supported clean-host loaded proxy configuration, host listener/NAT and alternate-ingress inventory, plus a disposable end-to-end route rehearsal, must bind this observation to the installation before startup can be authorized. The old Beget route checker remains scoped to R0003; no production request is made by the unit tests.

### Dedicated Caddy closed configuration observation

`renderClosedCleanCaddyConfig({ domain, adminSocket })` returns an experimental dedicated bootstrap JSON profile in memory. It has one HTTPS server, one exact hostname and a terminal static 502 handler, no reverse-proxy handler, no HTTP/3 listener and no configured access log. Automatic HTTP redirects are disabled. It does not install or load configuration and must not replace an existing shared proxy. TLS certificate provisioning and reboot behavior still need acceptance evidence.

`inspectClosedCleanCaddyConfig({ domain, adminSocket, ownerUid })` reads only `GET /config/` through an absolute Unix socket in a private directory owned by an explicitly supplied non-root service UID. It rejects symlinks, other-user access and socket/directory replacement across the read. The request has a five-second total deadline, 8 KiB header limit and 64 KiB body limit. It requires the entire returned JSON to match the dedicated profile: extra apps, servers, routes, handlers, logging, alternate listeners or admin endpoints fail closed. It returns only a normalized configuration digest and bounded status, not raw configuration.

`inspectCleanCaddyRoute` repeats that inspection around the host-bound public probe and requires both snapshots to agree. Its result remains `publicIngress: unproven`: a socket owned by the expected UID is not yet proof that the same process serves the public port, nor an inventory of NAT or other ingress. No default startup verifier is replaced. The next required proof binds the admin socket and public listener to the expected Caddy process and inventories alternate host ingress; full real Caddy/public TLS rehearsal remains open.

Validation covers the strict JSON profile and a real Unix HTTP fixture (not a Caddy daemon). A separate disposable Ubuntu 24.04 CI job runs the distribution's `caddy validate` and records its version; this provisions the candidate configuration without starting it and does not establish live route acceptance. References: [Caddy active configuration API](https://caddyserver.com/docs/api) and [static response handler](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/staticresp.go).

### Caddy process and socket binding

`inspectCleanCaddyProcess({ pid, ownerUid, executable, executableSha256, adminSocket })` is a root-only read-only Linux inspector. Its caller must supply the expected process, non-root UID and an independently trusted executable digest. It requires a root-controlled, non-symlink executable and parent chain, hashes its bytes, and matches the running `/proc/<pid>/exe` device/inode and path. Process birth ticks and all four UID values are checked across inspection; a dead, stopped, changed or inaccessible process fails closed. The process must share the inspector's host network namespace.

The inspector maps the protected admin pathname to exactly one listening Unix stream kernel inode, requires exactly one wildcard host TCP listener on port 443 across IPv4/IPv6, checks its UID, and verifies that this process owns FD links for both kernel socket inodes. A Unix pathname's filesystem inode is distinct from the kernel socket inode; both are checked for their respective purposes. Reads and FD inventories have explicit size/count limits. Environment and command-line contents are never read or emitted.

`inspectCleanCaddyProcessRoute` brackets the closed configuration/public-response observation with matching process snapshots. It reports `caddyProcess: socket-listener-bound` while keeping `publicIngress: unproven`. This does not prove exclusive FD ownership by only one process, systemd MainPID binding, binary trust distribution, host NAT or absence of other ingress. Those checks and full public TLS rehearsal remain required before replacing the default clean-startup blocker.

The disposable Caddy CI job additionally starts the distribution binary as the runner's non-root UID with a private admin socket and an inert HTTP listener on 443. Its fixture disables automatic TLS and makes no public HTTPS acceptance claim. Root inspection checks both socket inodes, stable birth/binary evidence, wrong UID/digest rejection and refusal after process exit. The test refuses an occupied 443, temporarily grants the distribution binary only the low-port bind capability, restores its prior capabilities and stops its child. It never runs against Beget. Linux evidence formats: [process birth ticks](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html), [socket FD links](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html), [kernel TCP tables](https://docs.kernel.org/networking/proc_net_tcp.html).

### Dedicated Caddy systemd and host inventory

`inspectCleanCaddySystemd` binds that process to an explicitly named non-transient service, a root-controlled unit file with independently supplied SHA-256, its loaded fragment, non-root account, exact MainPID, stable InvocationID and unified `/system.slice/<unit>` cgroup. It requires an active/running service, no control process or drop-ins and no pending daemon reload. The file and loaded manager evidence are checked around process/socket inspection. Selected manager properties never include environment or command-line text. This supports a dedicated root systemd/cgroup-v2 host only; aliases, nested slices and other managers are deliberately outside this profile.

`inspectCleanCaddyHost` inventories host IPv4/IPv6 TCP and UDP tables. It requires the sole public 443 inode to match Caddy and permits only root-owned SSH on port 22 plus non-web loopback listeners. Public UDP, another TCP port, a duplicate 443 or loopback 80/443 fails. A JSON nft inventory accepts only a conservative filter-only profile (input/output/forward hooks; matches, counters, limit, accept/drop/reject), rejects NAT, redirect, TPROXY, jumps, verdict maps, queues, flowtables and unknown objects, and omits volatile packet counters/handles from its configuration digest. Both legacy iptables families must have no rules. Every visible process FD is inspected to reject inherited ownership of either Caddy listening socket; inaccessible evidence fails, with 16,384 processes, 4,096 FDs per process, 262,144 total FDs and a 15-second FD scan deadline. Configuration with Docker NAT, UFW jumps, public DHCP listeners or other unrecognized firewall objects requires a separately supported profile; this checker never rewrites host rules or disables existing services.

`inspectCleanCaddyHostRoute` brackets the closed public/configuration observation with matching service and host snapshots. It still reports `publicIngress: unproven` and is not installed as the startup verifier. This is bounded evidence about the supported host tables, not a claim to inventory external load balancers, eBPF/TC routing, other network namespaces or every possible outbound tunnel. Independently trusted binary/unit inputs, certificate provisioning, a full real HTTPS/application rehearsal and the supported installation topology must be accepted before opening the production startup gate.

Disposable Ubuntu CI uses a fresh network namespace, preserves the runner's original services/firewall, starts real non-root Caddy through an actual systemd unit, rejects an added drop-in, extra public TCP listener and nft redirect, and verifies the original accepted inventory after cleanup. The fixture remains inert HTTP on port 443, with TLS disabled. Relevant formats: [systemctl runtime properties](https://github.com/systemd/systemd/blob/main/man/systemctl.xml) and [nftables objects and statements](https://netfilter.org/projects/nftables/manpage.html).

The closed renderer also accepts an optional exact `certificateFiles: { certificate, key }` pair with normalized, distinct absolute paths. When explicitly requested it adds only Caddy's file certificate loader; the full active configuration must match that pair. This does not provision or trust files, change the machine's CA store, or establish certificate renewal/reboot safety. The base automatic-TLS profile is unchanged.

The renderer explicitly pins the Unix admin endpoint's allowed origin/Host to `localhost`, matching the GET reader. Distribution Caddy 2.6.2 still enforces Host on Unix endpoints and otherwise expects an empty Host; its version-specific default rejected the real reader even though the generic Unix fixture and `caddy validate` passed. The integrated rehearsal covers this compatibility boundary, and a changed origin is rejected by the full JSON matcher. The endpoint remains a protected Unix socket, not a public admin listener. Reference: [Caddy 2.6.2 admin Host enforcement](https://github.com/caddyserver/caddy/blob/v2.6.2/admin.go).

After the inert HTTP checks, the disposable fixture starts the same real systemd service with a purpose-built leaf certificate and ephemeral CA, addresses `1.1.1.1` only inside its isolated namespace, and invokes `clean-caddy-https-client.mjs` in a separate Node process with that fixture CA. Real production readers check TLS, IP-pinned HTTPS `/mcp`, protected active JSON, process/socket, systemd and host inventory together. The client rejects an untrusted chain and a wrong hostname without disabling certificate verification. DNS resolution is explicitly simulated; no public address is contacted and no real-domain/public-CA or application acceptance is claimed. The client retains `publicIngress: unproven`. The namespace, service, files and temporary binary capability are cleaned up. This rehearsal is a supporting integration test, not OPS-01 or Direct 1.0 release acceptance.

### Local public IPv4 and kernel routing correlation

The combined Caddy host route inspection additionally requires a real local address binding. Bounded root `ip -j -4 addr/rule/route` readers execute in the exact Caddy network namespace with a minimal environment. The expected public IPv4 must appear exactly once on an up non-loopback interface with global scope and a valid IPv4 prefix. Only the dedicated default policy rules (priority 0/local, 32766/main and 32767/default) are accepted. The kernel lookup must return one local loopback route with the expected source/destination and no gateway, alternate device, encapsulation or route modifiers. NATed/cloud-private addressing and custom policy routing require separate supported profiles; the reader never changes production addresses or routing.

Address assignment and routing evidence are checked before the HTTPS observation and again afterward, alongside repeated host and pinned Caddy/systemd proofs. This prevents a closed response from a different remote machine from being correlated with an unrelated local Caddy process. Unit tests cover absent/foreign/duplicate/down/loopback assignments, malformed inventories, policy routing and non-local routes. The disposable namespace assigns its simulated public IPv4 to a dedicated dummy interface; real TLS CI temporarily removes the address and introduces an extra policy rule, requires refusal before the public request, then restores and rechecks the original fixture. DNS remains simulated and output remains `publicIngress: unproven`; no public release or default startup authorization is added.

### Fresh private installation controller

`installCleanPrivateRuntime` composes the previously separate journaled mutations from a verified prepared workspace into one fresh installation: service identities, private environment files, signed units, private data directories, version root, signed promotion, initial pointer, real systemd reload and persistent admission pause. It creates a new exclusive journal, rechecks all initially empty targets/accounts/ports before the first live mutation, and requires the exact journal identity and phase before and after every step. Each primitive's ready transition must match the controller's transaction, journal and next expected phase. Final success requires loaded inactive units and the actual paused admission flag.

By default the controller ends at `admission-ready`, with all application services inactive and `publicIngress: unproven`. The explicit OAuth owner option described below ends at `owner-ready` under the same inactive/paused boundary. It never starts/enables a service, resumes admission or creates a public route. An existing journal is rejected before any live operation; interruptions stop subsequent steps and retain the journal and the individual primitive's recovery lock. Recovery remains explicit through the corresponding existing recovery API, rather than an automatic destructive retry or blanket cleanup. This is an installer API with canonical existing service/configuration/data locations, not the public installation CLI or accepted OPS-01.

Disposable root Ubuntu CI builds an exact-commit artifact, signs it with a test-only ephemeral key and pins that key, performs actual private dependency installation, and invokes the controller with real NSS/shadow-utils identities, file ownership, unit installation, release promotion, pointer, systemd and admission primitives. The work account is an existing non-root runner account. Only the external DNS/TLS prerequisite is simulated for this inactive private-stage fixture; all mutations and verification are real. Test cleanup is confined to paths and names proven absent at entry, on the explicitly enabled disposable runner. Public pairing/OAuth, real-domain certificate provisioning, startup/exposure, failed-install recovery acceptance, updates and release signing-key custody remain separate requirements.

### Actual private application startup rehearsal

The initial inactive controller merged in #254 (96955d8), with all four CI jobs successful at 2c52bd4 (run 36888258448). Its complete real Linux fixture passed one test with zero failures/skips.

Application startup needs a distinct data boundary: Session Host and Agent create their SQLite/identity files before admitting requests. inspectCleanStartupData accepts only expected bounded regular startup files, journal-bound owners and service groups, private directories, no symlinks/hardlinks or unknown entries, and empty session/tmux directories. The inactive installation inspector continues requiring its original empty inventory. Journal completion, startup retry and recovery use initialized-state checks at the startup boundary. This does not adopt user sessions, transcripts or arbitrary existing data.

The starter waits for bounded actual paused health before inspecting bound listeners because Type=simple returns before application readiness. The optional explicitly enabled DP_TEST_REAL_CLEAN_STARTUP=1 disposable fixture installs actual signed source and dependencies, starts Session Host, deliberately fails the second start, verifies attempted units stopped and the pause/lock survived, rejects permissive files, unknown entries and a symlink, deliberately recovers, then explicitly retries all three actual signed application units. It verifies real paused health and denied HTTP admission. CI supplies its installed Node 22 PATH to the disposable manager only for this step and removes that override afterward.

Only external DNS/TLS preparation and the closed public route gate are simulated in this local rehearsal. The production route verifier still rejects startup. This is supporting actual application lifecycle evidence, not real-domain HTTPS/OAuth/pairing or full failed-install/release acceptance.

### Private OAuth candidate configuration

prepareCleanInstall and stageCleanInstallConfig accept an explicit authMode=oauth, ownerId and executionProfile. The OAuth profile defaults to files-read; full-shell explicitly advertises terminal and file scopes for later separate human browser consent. Selection is validated before clean preflight/preparation. Static remains the internal API default for the existing inactive/lifecycle fixtures; a public installer must deliberately select its accepted OAuth profile.

Four independent random secrets separate local Agent repair authorization, restricted OAuth Agent access, signed owner/grant request context, and owner approval. MCP receives the restricted Agent credential with matching context secret, never the unrestricted Agent repair token or a static MCP access token. Session Host receives no tokens, approval secrets or owner fields. Issuer/resource use the normalized HTTPS domain, the auth store remains private to MCP, ChatGPT CIMD is explicitly allowed, and telemetry is disabled.

The same six-file candidate manifest binds the selected configuration, and the existing journaled copier/verifier enforces exact installed bytes and service-group ownership. Tests exercise the actual Agent/MCP configuration loaders and invalid/ambiguous secrets/profiles. Disposable root CI prepares and installs the actual signed OAuth candidate, verifies service accounts can read their own configuration and cannot read other services' secrets, and retains inactive services with paused admission. This stage creates no owner, grant, authorization code or public route. Owner provisioning/recovery, OAuth application startup, real-domain pairing and publication remain required.

### Journaled clean OAuth owner bootstrap and recovery

The explicit OAuth configuration stage merged in #256 (6dd3691), with all four CI jobs successful at ac6478b (run 36891903203). Its signed private OAuth install/readability fixture passed 1, failed 0, skipped 0.

OAuth now requires admission-ready → owner-intent → owner-ready before startup-intent. Static internal fixture installs keep their direct admission-ready → startup-intent path. Bound authentication files are re-rendered against their exact supported profile after candidate verification; the public profile report contains mode, owner ID and execution profile only. Credentials stay internal and are never printed or passed in argv.

installCleanOwner requires signed installed source/configuration, inactive manager bindings, empty private data and persistent admission pause. It takes a durable exclusive transaction lock, runs the promoted signed auth-bootstrap script as the exact MCP service identity under a minimal environment, verifies the resulting private owner database and advances owner-ready. Any begun command or interrupted commit leaves the intent/lock for explicit recovery; retry never adopts an existing auth directory. The database must have the supported schema, valid integrity, one active consumed owner matching the staged bootstrap digest, and no pre-existing clients/grants/token families/refresh tokens. Read-only SQLite inspection runs as MCP because opening SQLite can create WAL/SHM coordination files even for a read-only query.

recoverCompletedCleanOwner runs only after the original installer stopped, checks its exact lock and unchanged journal/candidate/installed state, requires inactive paused services and the entire candidate-bound owner proof, then may advance a completed owner-intent or clear a leftover owner-ready lock. Partial, linked, altered, foreign or granted state remains locked. Startup, journal completion and startup recovery recheck the owner and its restricted private data inventory. This remains initial-install evidence; it cannot be used to adopt a previously paired production owner or database.

The disposable signed integration deliberately interrupts before the owner journal commit, verifies replay refusal and lock retention, rejects unsafe database permissions and a foreign owner, restores fixture state, explicitly recovers, and then exercises actual paused OAuth application startup plus stopped/active startup recovery. External DNS/TLS preparation and the closed route gate remain simulated for this local fixture. Owner initialization issues no OAuth grant and does not bypass later human browser consent; real-domain pairing, supported public topology and OPS-01/release acceptance remain separate.

### Composed fresh private OAuth owner installation

`installCleanPrivateRuntime({ initializeOwner: true, ... })` checks the signed, exact OAuth profile before journal creation or any live mutation, then runs the nine private installation phases and the owner transaction as one fresh operation. It retains the same transaction identity and exact phase checks around each primitive; owner completion cannot skip into startup or silently omit its journal commit. Final verification repeats the selected profile, candidate-bound owner, inactive systemd and paused admission proofs. Success returns `phase: owner-ready`, `owner: candidate-bound` and `publicIngress: unproven` without credentials. The default option remains false, preserving the existing private configuration-only boundary.

An interrupted owner phase stops the controller with its intent and recovery lock retained. An existing journal is always refused, even after successful owner provisioning; recovery remains a separate deliberate operation. Controller tests cover invalid/static selection before all mutations, interrupted/missing/skipped owner commits, changed profile and failed final owner proof. A separate explicitly enabled disposable Linux run builds the signed artifact and exercises the normal composed owner installation followed by real paused application startup and startup recovery. Its external DNS/TLS preparation and public route gate remain simulated; the runtime dependency manager PATH is fixture-only, and no public install, browser consent or release acceptance is claimed.

### Protected private operator entry

`node scripts/release/install-clean-private.mjs --request /var/lib/dp-install/request.json` composes candidate preparation and the fresh OAuth owner controller. Use trusted operator code and an independently pinned release key; the command does not establish signing-key trust, install host dependencies or configure certificates/proxy routing. Ubuntu 24.04, a supported Node/SQLite runtime, existing non-root work identity and allowed directory, required host tools, and an already valid DNS/HTTPS route remain prerequisites. No service starts or public access opens. Success ends at owner-ready with inactive application services, paused admission and unproven public ingress.

The request must be a regular root-owned mode 0600 file without symlinks/hardlinks in a real root-owned mode 0700 directory. Reading is bounded to 16 KiB and checks descriptor/path identity before and after. The JSON object requires exactly these non-secret fields (replace the example paths, existing work identity and host bindings for the target):

```json
{
  "format": "dp-beget-clean-private-request-v1",
  "artifact": "/var/lib/dp-install/artifacts/dp-beget-bridge-0.1.0.tar.gz",
  "manifest": "/var/lib/dp-install/artifacts/manifest.json",
  "signature": "/var/lib/dp-install/artifacts/manifest.sig",
  "trustDir": "/etc/dp-beget-release-trust",
  "domain": "bridge.example.com",
  "expectedIp": "1.1.1.1",
  "workUser": "bridge-work",
  "workGroup": "bridge-work",
  "agentUser": "dp-agent",
  "mcpUser": "dp-mcp",
  "ipcGroup": "dp-bridge-work",
  "allowedRoot": "/srv/bridge-work",
  "workspaceParent": "/var/lib/dp-install",
  "workspace": "/var/lib/dp-install/candidate",
  "releaseRoot": "/opt/dp-beget-bridge-runtime",
  "journalPath": "/var/lib/dp-install/installation.json",
  "ownerId": "owner-primary",
  "executionProfile": "files-read"
}
```

The trust directory must be outside the canonical clean installation targets; the historical default under `/etc/dp-beget-bridge` would occupy a target that fresh preflight deliberately rejects. Use an explicitly independently pinned external trust directory. The example artifact remains version 0.1.0 and is not a published 1.0.0 release. `files-read` and explicit `full-shell` are the supported profile selections; selecting a profile does not issue grants or bypass later human browser consent. Unknown fields, root identities, malformed/overlapping paths and unsupported profiles reject before preparation. Existing journal paths, including dangling symlinks, reject before candidate staging. Live interruption preserves the candidate and any transaction journal/locks; this command does not auto-retry, repair, purge or remove a partially installed owner. Read the retained phase and use its explicit recovery API after the original installer stopped.

Completion prints only transaction ID, signed version/commit and inactive/paused owner-ready status. Failures print a fixed message without exception text, child output, request content or credentials. Disposable CI reads the real protected request and performs real signed preparation, account/file/unit/data/pointer/systemd/pause and owner mutations, then separately rehearses paused startup/recovery. Its DNS/TLS preparation and startup route gate remain explicit injections. Public topology, runtime dependency provisioning, public installation CLI acceptance, actual pairing, updates and OPS-01 remain open.

The version-pointer module is an **unwired deployment primitive**. It accepts only a prepared `releases/<version>-<40-character-commit>` directory matching its package version, refuses unmanaged `current`/`previous` paths, takes an exclusive activation lock and switches the `current` symlink atomically. The caller supplies a health callback; failure restores the former pointer, and success records it as `previous`. The candidate's signed-archive `release-compatibility.json` must declare the three implemented SQLite schema versions; an existing managed `current` must carry the same record with identical versions. A schema-changing update fails before changing the pointer and needs a separate verified migration and rollback transaction. Equal version numbers alone do not prove data or API compatibility, actual live database state, or N/N−1 rollback acceptance. The module neither installs dependencies nor restarts services. The full updater must freeze admission, back up state, manage systemd units, prove readiness and restore service health after pointer rollback before OPS-06/07/09 can pass.

The separate root-only promotion primitive rechecks the pinned signature and extracted source files against the signed archive, rejects source changes and dependency links outside the release, and atomically moves the prepared directory to an unused `releases/<version>-<commit>` path on the same filesystem. Code becomes root-owned and readable by service identities only during that move. It does **not** change `current`, configure systemd, migrate data or stop any service:

```bash
node scripts/release/promote-prepared-release.mjs --workspace /private/prepared-release --release-root /new/root-owned/version-root
```

A read-only update preflight checks that an existing `current` link points to a managed version, required Session Host/Agent/MCP units are active and run as distinct non-root users from that link, optional OAuth/tunnel states are known, and Session Host uses `KillMode=process` so systemd restart does not kill tmux. It fails on the current mutable R0003 `/opt/dp-beget-bridge` service directory by design; a separately tested first migration to the versioned systemd layout is still required. This preflight does not freeze admission or prove that no operations are running:

```bash
node scripts/release/service-preflight.mjs --release-root /existing/version-root
```

An unwired SQLite backup module uses Node's online SQLite backup API and writes each named database into a new mode `0700` directory with mode `0600` copies. It checks source and backup integrity/schema, records size and SHA-256 without absolute source paths, and refuses insufficient free space or an existing output directory. The caller must stop admission and quiesce writes before a **multi-database** migration snapshot; these individually consistent backups are not an atomic snapshot across Agent, Session Host and OAuth. Transcript files, restore/recovery and retention are separate R0004 work.

A separate configuration-backup primitive copies a small, symlink-free configuration tree into another new mode `0700` directory with mode `0600` files. It records relative names, original numeric ownership/mode and SHA-256 but never logs credential values. Backup and restore remain unwired to services. The orchestrator must snapshot configuration and SQLite state together only after it has quiesced the relevant writers, without touching retained transcripts.

The standalone backup restore utility verifies the private backup directory, declared file inventory and checksums before creating a fresh output directory. Configuration restore records original numeric ownership and mode; restoring a different owner requires an appropriately privileged caller. SQLite restore checks SHA-256 again on the bytes copied and then checks SQLite integrity and schema in the output. The backup writer checkpoints the standalone copy into DELETE journal mode so no unrecorded WAL sidecars are needed. Neither restore function replaces a live database or configuration path, switches a service, or provides cross-service snapshot consistency:

```bash
node scripts/release/restore-backup.mjs config --backup-dir /private/backup/config --output-dir /new/private/restore/config
node scripts/release/restore-backup.mjs sqlite --backup-dir /private/backup/sqlite --output-dir /new/private/restore/sqlite
```

These are implementation primitives for rehearsing recovery. An updater must stop writers and freeze admission, take a grouped snapshot, perform versioned migrations, restore stopped services on failure, and verify the running old version after rollback before OPS-06/07/09 can be accepted.

A root-only grouped snapshot now requires the Agent, MCP, Session Host and any installed OAuth/tunnel units to be stopped both before and after capture. It combines the private configuration copy and explicit SQLite set into a new mode `0700` directory, binds the child manifests with SHA-256, syncs the files and directories, and discards an incomplete bundle on failure. The matching restore checks that binding and restores **only into another new private directory**. It cannot itself freeze admissions, stop services, select database paths, replace live state or prove that an external administrator did not restart a writer during the copy. A future updater must hold those service boundaries for the entire snapshot and rollback transaction.

An admission gate now exists in the MCP, Agent and Session Host HTTP entrypoints. With a root-owned, persistent `/var/lib/dp-beget-bridge-maintenance/admission-paused` flag, all non-health requests receive 503 while local health remains available. The root-only pause command creates the flag in a safe, traversable, non-writable-by-others directory; a code-level resume requires an explicit health verification callback and leaves the flag in place when that check fails. The CLI does **not** expose resume until the updater can prove full service and state health. The release transaction must establish the flag **before** stopping units and keep it through any restart/rollback. Existing in-flight file transfers and terminal operations still need to drain or fail safely before the state snapshot.

Each health response now includes `admission` and `inFlightRequests`. Non-health requests enter the counter before checking the pause flag, so an updater can establish the flag and then wait until all earlier work has finished. A bounded local drain probe requires `admission=paused` and `inFlightRequests=0` from Agent, MCP, Session Host and the OAuth listener if active. It fails on a missing or stalled probe. The terminal operation ledger still needs its separate restart preflight after MCP/Agent admission has stopped; this counter alone does not prove durable operations or filesystem transfers safe.

The read-only Beget inventory on 2026-09-23 confirmed the first-migration boundary: Agent/MCP/Session Host use `/opt/dp-beget-bridge`, while active OAuth uses `/opt/dp-beget-bridge-dp012-dcr` with `/etc/systemd/system/dp-beget-mcp-oauth-spike.service.d/10-dp012-dcr.conf`. The four services are loaded and active; Session Host uses `KillMode=process`, and `/opt` and `/var/lib/dp-beget-bridge` are on the same filesystem. A root-only first-migration unit backup primitive therefore requires exactly these code roots, saves four fragment files plus any scoped unit drop-ins into a private new directory, and records ownership/mode and SHA-256 without printing file content. It does not replace or restore live units, which must be covered by the migration transaction.
