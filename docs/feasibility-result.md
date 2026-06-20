# Feasibility Result — Live Test (2026-06-20)

Live deployment to Cloudflare account `bbbd6770…1d5b`
(`workbus-scheduled-runner.marcogworms.workers.dev`), container instance type
`standard-2`, targeting `murderteeth/workbus@feasibility-test`
(`.github/workflows/scheduled.yml`, a minimal `act`-compatible job).

## Verdict: VIABLE (with one real limitation + one ops constraint)

The core question — *can a Cloudflare Container run nested Docker well enough to
execute `act`?* — is **YES**. A full `act` workflow ran end-to-end on the
deployed Cloudflare Container.

## Findings (from live runs)

| Capability | Result | Evidence |
|---|---|---|
| Nested `dockerd` | ✅ works | `dockerd`+`containerd` boot, `overlay2` driver, `docker0` bridge `172.17.0.0/16`, "Daemon has completed initialization"; real containers run. `docker.ok=true mode=inner-dockerd` |
| Repo checkout | ✅ works | shallow fetch + detached checkout at head SHA |
| `act` end-to-end | ✅ works | pulled `node:16-buster-slim` from Docker Hub, "Set up job ✅", both steps succeeded, "Job succeeded 🏁", `act.ok=true exitCode=0` |
| Image pull (small, Docker Hub) | ✅ works | `alpine:3.20`, `node:16-buster-slim` pulled fine |
| Image pull (large, ghcr.io) | ❌ fails | `catthehacker/ubuntu:act-latest` → `context canceled` ~36s into pull, no progress, no network error (see "Open limitation") |
| Service containers | ❌ fails (likely fixable) | `ping: bad address …-svc`; "No non-localhost DNS nameservers are left in resolv.conf" — Docker embedded DNS does not resolve container names on user-defined networks. **Likely caused by `--iptables=false` on the inner `dockerd` (`runner/server.js`)**, which suppresses the NAT rules the embedded resolver (`127.0.0.11`) needs — see follow-up below |
| Secret injection + masking | ✅ works | secrets reach `act`; git auth header logs as `bearer ***`; raw token absent from log |
| R2 reports/logs | ✅ works | `report.json` + `runner.log` written per run under `runs/<owner>/<repo>/…` |
| GitHub commit status | ✅ works | `workbus/cloudflare-schedule: success` posted on head SHA |
| Timeout handling | ⊘ not stress-tested | `timeout.ok=true`; no deliberate-timeout run performed |
| Artifacts | ⊘ not exercised | test workflow produces no artifacts (`artifacts.ok=false skipped=false`, expected) |

## Open limitation: large runner-image pull

`act`'s standard runner image (`catthehacker/ubuntu:act-latest`, ghcr.io, ~1GB+)
consistently `context canceled` ~36s into the pull while the total request
finished ~42–45s. Small Docker Hub images (`alpine`, `node:16-buster-slim`)
pull fine.

This is **not** a documented size cap: per the CF docs, an instance's max image
size equals its disk space — **12 GB on `standard-2`** (lite 2 / basic 4 /
standard-1 8 / standard-3 16 / standard-4 20 GB), with 50 GB total image storage
per account. The docs state no request-duration or networking limits. So the
large pull is failing at runtime (egress throughput within an effective ~40s
window), not against a stated limit.

**Resolved (this iteration):** the runner now **bakes a small Debian image
(`node:22-bookworm-slim`) into the container image** via `skopeo` at build time
and `docker load`s it into the inner `dockerd` at runtime, with `act --pull=false`
— eliminating the runtime pull entirely. Note: `*-slim` is intentionally minimal
(Node + base OS, no `git`/`curl` preinstalled); workflows needing more tooling
should bake a richer Debian runner image or fall back to `catthehacker`.

## Follow-up (not yet done)

- **Service-container DNS:** re-test the inner `dockerd` *with* iptables enabled
  (drop `--iptables=false` in `runner/server.js`) to see whether embedded DNS
  starts resolving service names — and whether `dockerd` still starts given the
  netfilter capabilities the CF container runtime grants. `--iptables=false` was
  likely added to avoid a startup permission error; confirm before concluding
  `services:` is unsupported.
- Add a deliberate-timeout test; observe a real cron firing.

## Prototype bugs found & fixed during the test

1. **`act` first-run interactive image picker → EOF.** With no `actrc`, `act`
   prompted for a default image and hit EOF on non-TTY stdin (`level=fatal
   msg=EOF`). Fixed by baking `/root/.config/act/actrc` into the Dockerfile and
   passing `-P` in `runner/server.js`.
2. Runtime image mapping added in `runner/server.js` (`-P ubuntu-latest=…`).

(Operational note: `wrangler r2 object get` defaults to the **local** simulator
bucket — must pass `--remote` to read live reports. Not a code bug.)

(Operational gotcha: a DO-pinned container instance — `getContainer(ns,
"scheduled-runner")` — keeps running its **original image even across
sleep/wake**; a plain `wrangler deploy` of a new image does not replace it.
During the test, forcing a fresh image required `wrangler containers delete
<app-id>` followed by `wrangler deploy`. Worth solving properly — e.g. a
versioned instance name or an explicit recycle — before relying on this for
deploys.)

## Pass/fail vs README criteria

PASS: container starts on demand, checkout, `docker.ok`, `act.ok`, R2
report+log, secrets injected without leaking, GitHub status delivered.
FAIL/CONSTRAINT: service-container DNS networking; large runner-image pull
within the request window. Cron firing and deliberate-timeout behavior deployed
but not yet observed live.

## Recommendation

Viable as an internal scheduler for **container workflows that (a) don't rely on
`services:` networking and (b) use runner images small enough to pull in-window
or baked into the image**. Next steps: bake runner images into the Dockerfile,
add a deliberate-timeout test, observe a real cron firing, and investigate the
service-container DNS (embedded resolver / `--iptables`/`--dns` flags on the
inner `dockerd`).
