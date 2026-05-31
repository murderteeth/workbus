# Workbus Scheduled Runner Prototype

Prototype for replacing a narrow class of unreliable GitHub Actions `schedule`
workflows with Cloudflare Cron Triggers plus Cloudflare Containers.

The scope is intentionally small:

- One Cloudflare Worker.
- One Cron Trigger.
- One Cloudflare Container image.
- One configured GitHub repository/ref.
- One selected `.github/workflows/*.yml` workflow.
- R2-backed run reports, logs, and small artifact bundles.
- Optional GitHub commit status and Slack notifications.

## Architecture

1. Cloudflare Cron Trigger invokes `scheduled()` in `src/index.ts`.
2. The Worker sends a run request to one named `ActionsRunnerContainer`.
3. The container HTTP service in `runner/server.js`:
   - probes Docker availability;
   - optionally tries to start an inner `dockerd`;
   - optionally probes Docker service-container style networking;
   - checks out `RUNNER_REPO` at `RUNNER_REF`;
   - writes selected secrets to an `act` secret file;
   - runs the configured workflow with `act`;
   - returns logs, findings, and a small artifact tarball to the Worker.
4. The Worker writes `report.json`, `runner.log`, and optional `artifacts.tgz`
   to R2.
5. The Worker optionally posts a GitHub commit status and/or Slack webhook.

## Key Feasibility Question

`act` uses the Docker API to run workflow job containers and service containers.
Cloudflare Containers can run Linux containers, but this prototype must prove
whether nested Docker behavior works well enough for Actions-compatible
execution. The runner reports these findings on every run:

- `docker`: whether a Docker API is available or an inner `dockerd` can start.
- `serviceContainers`: whether Docker networked service containers work.
- `act`: whether `act` can execute the selected workflow.
- `secrets`: which secret names were injected.
- `logs`: whether logs were captured and returned.
- `timeout`: whether the configured timeout was respected.
- `artifacts`: whether small artifacts were bundled and stored in R2.
- notifications: inferred from Worker logs and GitHub/Slack side effects.

If `docker.ok` is false, this architecture is not viable for workflows that need
normal Actions container execution. It may still be viable only for a narrower
non-container runner mode or a custom shell-only executor.

## Configure

Edit `wrangler.toml`:

```toml
[triggers]
crons = ["17 * * * *"]

[vars]
RUNNER_REPO = "owner/repo"
RUNNER_REF = "main"
RUNNER_WORKFLOW = ".github/workflows/scheduled.yml"
RUNNER_EVENT_NAME = "schedule"
RUNNER_TIMEOUT_SECONDS = "900"
RUNNER_ENABLE_DOCKERD = "1"
RUNNER_ENABLE_SERVICE_PROBE = "1"
RUNNER_R2_PREFIX = "runs"
GITHUB_STATUS_CONTEXT = "workbus/cloudflare-schedule"
```

Create the R2 bucket:

```bash
npx wrangler r2 bucket create workbus-run-reports
```

Set secrets:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put RUNNER_TRIGGER_TOKEN
npx wrangler secret put RUNNER_SECRETS_JSON
npx wrangler secret put SLACK_WEBHOOK_URL
```

`RUNNER_SECRETS_JSON` is optional JSON for workflow secrets, for example:

```json
{"NPM_TOKEN":"...","API_KEY":"..."}
```

`GITHUB_TOKEN` is used for private checkout, passed to `act` as
`GITHUB_TOKEN`, and used by the Worker to create a commit status.

## Run

Install dependencies and typecheck:

```bash
npm install
(cd runner && npm install)
npm run typecheck
```

Local Worker cron simulation:

```bash
npm run dev
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

Manual deployed run:

```bash
curl -X POST \
  -H "Authorization: Bearer $RUNNER_TRIGGER_TOKEN" \
  "https://<worker-host>/run"
```

Deploy:

```bash
npm run deploy
```

After a run, inspect R2 keys under:

```text
runs/<owner>/<repo>/.github_workflows_<workflow>/<run-id>/
```

## Pass/Fail Criteria

Pass for becoming a real internal scheduler:

- Container starts from Cron reliably.
- Checkout succeeds for the configured repo/ref.
- `docker.ok` and `serviceContainers.ok` are true.
- `act.ok` is true for the selected workflow.
- Report and log objects are present in R2.
- Secrets are available to the workflow without appearing in logs.
- Timeout failures produce an R2 report and notification.
- GitHub status or Slack notification is delivered.

Fail or redesign:

- Inner Docker cannot start and no Docker socket/API is available.
- Service-container networking fails for workflows that need services.
- Worker-to-container request lifetime is too short for expected jobs.
- Artifact output is too large for the Worker response path.
- Required secrets cannot be injected safely.

## Current Assumptions

- The prototype is for a trusted internal workflow, not arbitrary untrusted code.
- The selected workflow is expected to run on Linux amd64.
- Artifacts are capped at 5 MiB in this prototype and returned inline to the
  Worker before being stored in R2.
- R2 reports are private unless a separate public/custom-domain layer is added.
