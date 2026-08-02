# workbus

Run your scheduled GitHub workflows on **Cloudflare Containers** instead of
GitHub Actions. workbus is open source and **self-hosted**: you deploy it to your
own Cloudflare account, install its GitHub App on your repos, and it runs the
workflows you move into a `.workbus/` directory — on their own schedules,
isolated per run, scaling to zero between runs.

`.workbus/` is to workbus what `.github/workflows/` is to GitHub Actions. To move
a scheduled workflow over:

```bash
git mv .github/workflows/nightly.yml .workbus/nightly.yml
# set any secrets it needs in the workbus dashboard, then commit + push
```

Moving the file **out** of `.github/workflows/` stops Actions from running it;
moving it **into** `.workbus/` makes workbus pick it up. The file's location is
the single source of truth for who runs it — clean cutover, no double execution.

Workflows run with [`act`](https://github.com/nektos/act), so most `schedule`-
driven, `act`-compatible workflows work with no changes beyond re-providing their
secrets. See [Compatibility](#compatibility--limitations).

## How it works

```
GitHub App (installed on your repos)
   │  contents:read, metadata:read, checks:write, webhooks
   ▼
Cloudflare Worker (src/index.ts)
   ├─ /setup        create the App via a manifest flow
   ├─ /webhooks     push / installation events → resync the .workbus/ catalog
   ├─ discovery     list repos → read .workbus/*.yml → parse on.schedule → D1 jobs
   ├─ scheduler     minute cron tick → jobs due now → Queue
   └─ dashboard     /jobs /runs /secrets (Sign in with GitHub)
   ▼
Cloudflare Queue (workbus-runs)
   ▼
per-run Container (runner/server.js): mint installation token → checkout →
   run the workflow with act → report to R2 + D1, post a GitHub check
```

- **Discovery** finds every `.workbus/*.yml` across your installed repos and turns
  each into a job (schedule taken from the file's `on.schedule` cron).
- **Scheduling** is a one-minute cron tick that enqueues jobs whose cron is due.
- **Execution** happens in a fresh Cloudflare Container per run — isolated,
  cold-started on the current image, then stopped so it bills only while running
  (~seconds per run).
- **Secrets** you set in the dashboard are AES-256-GCM encrypted at rest and
  injected into runs as `${{ secrets.NAME }}`, masked in logs.

The feasibility work behind this (nested Docker on Cloudflare Containers, cost,
scale-to-zero) is written up in [`docs/feasibility-result.md`](docs/feasibility-result.md).

## Self-hosting

**Prerequisites:** a Cloudflare account on the **Workers Paid** plan (Containers
require it), `wrangler`, Node, and a GitHub org/account you can install an App on.

### 1. Create the Cloudflare resources

```bash
npx wrangler r2 bucket create workbus-run-reports
npx wrangler d1 create workbus          # put the printed database_id into wrangler.toml
npx wrangler d1 migrations apply workbus --remote
npx wrangler queues create workbus-runs
```

### 2. Set secrets

```bash
# Master key for encrypting workflow secrets (required for the secrets feature)
openssl rand -base64 32 | npx wrangler secret put SECRETS_MASTER_KEY
# Bearer token for the run/API endpoints (optional; enables headless automation)
openssl rand -hex 24   | npx wrangler secret put RUNNER_TRIGGER_TOKEN
```

### 3. Deploy

```bash
npm install
npm run deploy   # scripts/deploy.sh: hashes runner/ into RUNNER_HASH so a changed
                 # runner always rebuilds the image, and rolls out immediately
```

### 4. Create + install the GitHub App

Visit `https://<your-worker-host>/setup` (add `?org=YOUR_ORG` to create it in an
org). It runs GitHub's **App Manifest** flow — one click creates the App in your
account with the right permissions, and workbus stores its credentials. Then
follow the **Install** link and choose the repos workbus should manage.

The App is created with an OAuth callback (`/login/callback`) so you can sign in
to the dashboard. Once installed, workbus discovers `.workbus/` files
automatically (on push) — or hit `/setup/resync` to force a scan.

### 5. Migrate a workflow

In a managed repo: `git mv .github/workflows/<wf>.yml .workbus/<wf>.yml`, set its
secrets under **/secrets** in the dashboard, commit, and push. It appears under
**/jobs** and runs on its schedule. Use **run now** to validate it first.

## Dashboard

Gated by "Sign in with GitHub" (you must belong to an org / own an account where
the App is installed). API endpoints also accept `Authorization: Bearer
$RUNNER_TRIGGER_TOKEN`.

- **`/jobs`** — discovered `.workbus/` workflows, their crons, and **run now**.
- **`/runs`**, **`/runs/view?id=…`** — run history, findings, and logs (from D1/R2).
- **`/secrets`** — set/delete repo-scoped secrets (values never shown after saving).
- **`/setup/status`** — App + installations; **`/setup/resync`** — rescan `.workbus/`.

## Compatibility & limitations

workbus runs workflows with `act`, which covers most simple scheduled workflows
but is not a 1:1 GitHub Actions replacement. Known gaps are tracked as issues:

- `services:` containers — [#2](../../issues/2)
- non-schedule triggers (push / pull_request) — [#3](../../issues/3)
- `actions/cache` — [#4](../../issues/4) · OIDC — [#5](../../issues/5)
- non-default-branch discovery — [#6](../../issues/6)
- multiple crons per workflow — [#8](../../issues/8)
- multi-tenant SaaS mode — [#1](../../issues/1)

Best fit today: **schedule-driven, `act`-compatible workflows that don't need
`services:` networking**, using runner images small enough to run in-container
(the default is a baked Debian image).

## Development

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run dev            # local Worker (wrangler dev)
npm run deploy         # build + deploy (see scripts/deploy.sh)
```

Layout: `src/index.ts` (Worker: routing, scheduler, dashboard), `src/github.ts`
(App JWT + installation tokens + webhooks), `src/discovery.ts` (`.workbus/`
catalog), `src/cron.ts` (schedule matching), `src/auth.ts` (dashboard sessions),
`src/secrets.ts` (secret encryption), `runner/server.js` (in-container runner),
`migrations/` (D1 schema).

The `RUNNER_*` vars in `wrangler.toml` drive only the legacy single-job `/run`
test endpoint; real jobs come from `.workbus/` discovery.
