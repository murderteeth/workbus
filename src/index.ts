import { Container, getContainer } from "@cloudflare/containers";
import {
  type AppConfig,
  exchangeManifestCode,
  getInstallationToken,
  ghHeaders,
  verifyWebhookSignature
} from "./github";
import { listInstallationRepos, readWorkbusWorkflows } from "./discovery";
import { cronMatches } from "./cron";
import {
  type Session,
  parseCookies,
  randomToken,
  serializeCookie,
  signSession,
  verifySession
} from "./auth";
import { decryptSecret, encryptSecret, isValidSecretName } from "./secrets";

type RunStatus = "success" | "failure" | "error";

interface QueueMessage {
  jobId: string;
  scheduledFor: string;
}

interface Env {
  ACTIONS_RUNNER: DurableObjectNamespace<ActionsRunnerContainer>;
  RUN_REPORTS: R2Bucket;
  DB: D1Database;
  QUEUE: Queue<QueueMessage>;
  RUNNER_REPO: string;
  RUNNER_REF: string;
  RUNNER_WORKFLOW: string;
  RUNNER_EVENT_NAME?: string;
  RUNNER_JOB?: string;
  RUNNER_TIMEOUT_SECONDS?: string;
  RUNNER_ENABLE_DOCKERD?: string;
  RUNNER_ENABLE_SERVICE_PROBE?: string;
  RUNNER_R2_PREFIX?: string;
  RUNNER_SECRETS_JSON?: string;
  RUNNER_TRIGGER_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_STATUS_CONTEXT?: string;
  SLACK_WEBHOOK_URL?: string;
  // GitHub App credentials (optional; override the D1 app_config row).
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  // 32-byte base64 master key for encrypting user workflow secrets.
  SECRETS_MASTER_KEY?: string;
}

interface RunnerResult {
  runId: string;
  repo: string;
  ref: string;
  workflow: string;
  eventName: string;
  startedAt: string;
  completedAt: string;
  status: RunStatus;
  exitCode: number;
  headSha?: string;
  log?: string;
  logSha256?: string;
  findings?: Record<string, unknown>;
  artifactBundleBase64?: string;
  artifactBundleBytes?: number;
}

interface StoredReport {
  reportKey: string;
  logKey: string;
  artifactKey?: string;
  result: RunnerResult;
}

// A single unit of scheduled work: one workflow file in one repo at one ref,
// plus the credentials/secrets it runs with. Today there is one job, built from
// env (jobFromEnv). The control plane (D1 + `.workbus/` discovery) will produce
// these from many repos without changing runJob.
interface Job {
  repo: string;
  ref: string;
  workflow: string;
  eventName: string;
  job?: string;
  githubToken: string;
  secrets: Record<string, string>;
}

function jobFromEnv(env: Env): Job {
  return {
    repo: env.RUNNER_REPO,
    ref: env.RUNNER_REF,
    workflow: env.RUNNER_WORKFLOW,
    eventName: env.RUNNER_EVENT_NAME || "schedule",
    job: env.RUNNER_JOB || undefined,
    githubToken: env.GITHUB_TOKEN || "",
    secrets: buildSecretMap(env)
  };
}

export class ActionsRunnerContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "15s";
  pingEndpoint = "ping";

  override onStart() {
    console.log("actions runner container started");
  }

  override onStop(params: { exitCode: number; reason: string }) {
    console.log("actions runner container stopped", params);
  }

  override onError(error: unknown) {
    console.log("actions runner container error", error);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // GitHub -> workbus webhook: always open (HMAC-verified inside).
    if (request.method === "POST" && path === "/webhooks/github") {
      return handleWebhook(env, request, ctx);
    }

    // Dashboard login flow.
    if (request.method === "GET" && path === "/login") return startLogin(env, url);
    if (request.method === "GET" && path === "/login/callback") return finishLogin(env, url, request);
    if (request.method === "GET" && path === "/logout") return logout();

    // Gate the dashboard behind a GitHub session. The API endpoints also accept
    // the RUNNER_TRIGGER_TOKEN bearer. Exception: /setup before an App exists
    // (bootstrap), so the deployer can create the App.
    const configured = await isAppConfigured(env);
    const session = await getSession(request, env);
    const bearerOk = !!env.RUNNER_TRIGGER_TOKEN &&
      (request.headers.get("authorization") || "") === `Bearer ${env.RUNNER_TRIGGER_TOKEN}`;
    const bootstrap = !configured && (path === "/setup" || path === "/setup/callback");
    if (!bootstrap && !session && !bearerOk) {
      if (request.method === "GET") return Response.redirect(`${url.origin}/login`, 302);
      return new Response("unauthorized", { status: 401 });
    }

    if (request.method === "GET" && path === "/") return Response.redirect(`${url.origin}/jobs`, 302);
    if (request.method === "GET" && path === "/runs") return renderRunsList(env, url);
    if (request.method === "GET" && path === "/runs/view") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("missing id", { status: 400 });
      return renderRunDetail(env, id);
    }
    if (request.method === "GET" && path === "/setup") return renderSetup(url);
    if (request.method === "GET" && path === "/setup/callback") return handleSetupCallback(env, url);
    if (request.method === "GET" && path === "/setup/status") return renderSetupStatus(env, url);
    if (request.method === "GET" && path === "/setup/resync") {
      const summary = await resyncCatalog(env);
      return htmlResponse(`<h1>resync complete</h1>
        <p>${summary.repos} repo(s), ${summary.jobs} job(s).</p>
        <p><a href="/jobs">jobs</a> &middot; <a href="/setup/status">status</a></p>`);
    }
    if (request.method === "GET" && path === "/jobs") return renderJobs(env);
    if (request.method === "POST" && path === "/jobs/run") {
      const jobId = url.searchParams.get("id");
      if (!jobId) return new Response("missing id", { status: 400 });
      const stored = await runDiscoveredJob(env, jobId);
      return stored ? Response.json(stored) : new Response("job not found or app not configured", { status: 404 });
    }
    if (request.method === "GET" && path === "/secrets") return renderSecrets(env);
    if (request.method === "POST" && path === "/secrets") return handleSetSecret(env, request, url);
    if (request.method === "POST" && path === "/secrets/delete") return handleDeleteSecret(env, request, url);
    if (request.method === "POST" && path === "/run") {
      const stored = await runJob(env, jobFromEnv(env), "manual");
      return Response.json(stored);
    }
    if (request.method === "POST" && path === "/cdn-cgi/handler/scheduled") {
      const stored = await runJob(env, jobFromEnv(env), "local-scheduled-test");
      return Response.json(stored);
    }
    return new Response("not found", { status: 404 });
  },

  // Minute tick: enqueue discovered jobs whose cron is due now.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scheduleTick(env));
  },

  // Queue consumer: run one enqueued job, re-checking it still exists + is
  // enabled at dispatch time (a job removed after enqueue is skipped).
  async queue(batch: MessageBatch<QueueMessage>, env: Env, _ctx: ExecutionContext) {
    for (const msg of batch.messages) {
      const { jobId } = msg.body;
      try {
        const built = await buildJobFromId(env, jobId, "schedule");
        if (!built) {
          console.log("queued job no longer exists, skipping", jobId);
        } else if (!built.enabled) {
          console.log("queued job disabled, skipping", jobId);
        } else {
          await runJob(env, built.job, "cron");
        }
      } catch (error) {
        console.log("queued job run failed", jobId, error);
      }
      msg.ack();
    }
  }
};

// Evaluate every enabled, scheduled job against the current minute and enqueue
// those due. last_run_at (minute precision) dedups within a minute.
async function scheduleTick(env: Env): Promise<void> {
  const now = new Date();
  const minute = now.toISOString().slice(0, 16);
  const { results } = await env.DB.prepare(
    `SELECT id, cron, last_run_at FROM jobs WHERE enabled = 1 AND cron IS NOT NULL AND cron != ''`
  ).all<{ id: string; cron: string; last_run_at: string | null }>();

  for (const job of results || []) {
    if (!cronMatches(job.cron, now)) continue;
    if (job.last_run_at && job.last_run_at.slice(0, 16) >= minute) continue;
    await env.QUEUE.send({ jobId: job.id, scheduledFor: now.toISOString() });
    await env.DB.prepare(`UPDATE jobs SET last_run_at = ? WHERE id = ?`).bind(now.toISOString(), job.id).run();
  }
}

async function runJob(env: Env, job: Job, source: string, cron?: string): Promise<StoredReport> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const timeoutSeconds = clampInt(env.RUNNER_TIMEOUT_SECONDS, 60, 3600, 900);
  let result: RunnerResult;

  // One container instance per run (keyed by runId) so concurrent jobs are
  // isolated and each run cold-starts on the latest image, then scales to zero.
  const container = getContainer(env.ACTIONS_RUNNER, runId);

  try {
    const requestBody = {
      runId,
      source,
      cron,
      repo: job.repo,
      ref: job.ref,
      workflow: job.workflow,
      eventName: job.eventName,
      job: job.job,
      timeoutSeconds,
      enableDockerd: parseBool(env.RUNNER_ENABLE_DOCKERD, true),
      enableServiceProbe: parseBool(env.RUNNER_ENABLE_SERVICE_PROBE, true),
      githubToken: job.githubToken,
      secrets: job.secrets
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("runner timeout"), (timeoutSeconds + 30) * 1000);

    let response: Response;
    try {
      response = await container.fetch("http://container/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`runner container returned ${response.status}: ${body.slice(0, 500)}`);
    }

    result = await response.json<RunnerResult>();
  } catch (error) {
    result = {
      runId,
      repo: job.repo,
      ref: job.ref,
      workflow: job.workflow,
      eventName: job.eventName,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "error",
      exitCode: 1,
      log: error instanceof Error ? error.stack || error.message : String(error),
      findings: {
        workerToContainer: {
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        }
      }
    };
  } finally {
    // This is a one-shot scheduled job: once the run is done, stop the
    // container immediately so it scales to zero. The library's sleepAfter
    // idle timeout does not reliably fire for this DO-pinned single instance
    // (the activity timer is renewed on every DO re-instantiation), so the
    // container otherwise stays warm and billable indefinitely.
    try {
      await container.stop();
    } catch (stopError) {
      console.log("failed to stop runner container", stopError);
    }
  }

  const stored = await storeReport(env, result);
  await recordRun(env, result, stored, source);
  await Promise.allSettled([
    notifyGitHub(env, result, stored),
    notifySlack(env, result, stored)
  ]);
  return stored;
}

// Persist a run row to D1 for the history UI (alongside the R2 report/log).
// Best-effort: a logging failure must not fail the run.
async function recordRun(env: Env, result: RunnerResult, stored: StoredReport, source: string): Promise<void> {
  try {
    const f = (result.findings || {}) as Record<string, { ok?: boolean } | undefined>;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO runs
         (id, source, repo, ref, workflow, status, exit_code, head_sha,
          started_at, completed_at, report_key, log_key, artifact_key,
          docker_ok, act_ok, services_ok, findings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        result.runId,
        source,
        result.repo,
        result.ref ?? null,
        result.workflow,
        result.status,
        result.exitCode ?? null,
        result.headSha ?? null,
        result.startedAt ?? null,
        result.completedAt ?? null,
        stored.reportKey,
        stored.logKey,
        stored.artifactKey ?? null,
        boolToInt(f.docker?.ok),
        boolToInt(f.act?.ok),
        boolToInt(f.serviceContainers?.ok),
        result.findings ? JSON.stringify(result.findings) : null
      )
      .run();
  } catch (error) {
    console.log("failed to record run in D1", error);
  }
}

function boolToInt(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

async function storeReport(env: Env, result: RunnerResult): Promise<StoredReport> {
  const prefix = (env.RUNNER_R2_PREFIX || "runs").replace(/^\/+|\/+$/g, "");
  const baseKey = `${prefix}/${result.repo}/${result.workflow.replaceAll("/", "_")}/${result.runId}`;
  const reportKey = `${baseKey}/report.json`;
  const logKey = `${baseKey}/runner.log`;
  const artifactKey = result.artifactBundleBase64 ? `${baseKey}/artifacts.tgz` : undefined;

  const reportForStorage = { ...result };
  delete reportForStorage.log;
  delete reportForStorage.artifactBundleBase64;

  await env.RUN_REPORTS.put(reportKey, JSON.stringify(reportForStorage, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
  await env.RUN_REPORTS.put(logKey, result.log || "", {
    httpMetadata: { contentType: "text/plain; charset=utf-8" }
  });

  if (artifactKey && result.artifactBundleBase64) {
    await env.RUN_REPORTS.put(artifactKey, base64ToBytes(result.artifactBundleBase64), {
      httpMetadata: { contentType: "application/gzip" }
    });
  }

  return { reportKey, logKey, artifactKey, result: reportForStorage };
}

async function notifyGitHub(env: Env, result: RunnerResult, stored: StoredReport) {
  if (!env.GITHUB_TOKEN || !result.headSha || !/^[^/]+\/[^/]+$/.test(result.repo)) return;

  const [owner, repo] = result.repo.split("/");
  const state = result.status === "success" ? "success" : result.status === "failure" ? "failure" : "error";
  const description = `Cloudflare scheduled runner ${result.status}`.slice(0, 140);
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/statuses/${result.headSha}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "workbus-scheduled-runner"
    },
    body: JSON.stringify({
      state,
      description,
      context: env.GITHUB_STATUS_CONTEXT || "workbus/cloudflare-schedule"
    })
  });

  if (!response.ok) {
    console.log("github status notification failed", response.status, await response.text());
  } else {
    console.log("github status notification sent", stored.reportKey);
  }
}

async function notifySlack(env: Env, result: RunnerResult, stored: StoredReport) {
  if (!env.SLACK_WEBHOOK_URL) return;

  const response = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: [
        `workbus ${result.status}: ${result.repo} ${result.workflow}`,
        `ref=${result.ref}`,
        `run=${result.runId}`,
        `report=${stored.reportKey}`
      ].join("\n")
    })
  });

  if (!response.ok) {
    console.log("slack notification failed", response.status, await response.text());
  }
}

function buildSecretMap(env: Env): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (env.RUNNER_SECRETS_JSON) {
    const parsed = JSON.parse(env.RUNNER_SECRETS_JSON) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === "string") {
        secrets[key] = value;
      }
    }
  }
  if (env.GITHUB_TOKEN) {
    secrets.GITHUB_TOKEN = env.GITHUB_TOKEN;
  }
  return secrets;
}

// ===========================================================================
//   GitHub App: setup (manifest flow), config, and webhooks
// ===========================================================================

// App credentials come from Worker secrets if set, otherwise the D1 app_config
// row written by the /setup flow.
async function loadAppConfig(env: Env): Promise<AppConfig | undefined> {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
    return {
      appId: Number.parseInt(env.GITHUB_APP_ID, 10),
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET
    };
  }
  const row = await env.DB.prepare(
    `SELECT app_id, private_key, webhook_secret, slug, client_id FROM app_config WHERE id = 1`
  ).first<{ app_id: number; private_key: string; webhook_secret: string | null; slug: string | null; client_id: string | null }>();
  if (!row) return undefined;
  return {
    appId: row.app_id,
    privateKey: row.private_key,
    webhookSecret: row.webhook_secret ?? undefined,
    slug: row.slug ?? undefined,
    clientId: row.client_id ?? undefined
  };
}

// Renders an auto-submitting form that POSTs a GitHub App Manifest to GitHub,
// which creates the App and redirects back to /setup/callback with a code.
function renderSetup(url: URL): Response {
  const base = url.origin;
  const org = url.searchParams.get("org");
  const action = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  const manifest = {
    name: `workbus-${crypto.randomUUID().slice(0, 8)}`,
    url: base,
    hook_attributes: { url: `${base}/webhooks/github`, active: true },
    redirect_url: `${base}/setup/callback`,
    // OAuth callback for "Sign in with GitHub" on the dashboard.
    callback_urls: [`${base}/login/callback`],
    public: false,
    default_permissions: { contents: "read", metadata: "read", checks: "write" },
    // installation / installation_repositories are automatic app-lifecycle
    // events (always delivered) and are not valid in default_events.
    default_events: ["push"]
  };
  const body = `<h1>Create the workbus GitHub App</h1>
    <p>This creates a GitHub App${org ? ` in <code>${esc(org)}</code>` : " on your account"} with
       read access to code + metadata and write access to checks, then returns here.
       (Add <code>?org=YOUR_ORG</code> to create it in an organization.)</p>
    <form id="f" method="post" action="${esc(action)}">
      <input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
      <button type="submit">Create GitHub App</button>
    </form>
    <script>document.getElementById("f").submit()</script>`;
  return htmlResponse(body);
}

async function handleSetupCallback(env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  if (!code) return htmlResponse(`<h1>Setup error</h1><p>Missing <code>code</code>.</p>`);
  let conv;
  try {
    conv = await exchangeManifestCode(code);
  } catch (error) {
    return htmlResponse(`<h1>Setup failed</h1><pre>${esc(error instanceof Error ? error.message : String(error))}</pre>`);
  }
  await env.DB.prepare(
    `INSERT OR REPLACE INTO app_config (id, app_id, slug, private_key, webhook_secret, client_id, client_secret)
     VALUES (1, ?, ?, ?, ?, ?, ?)`
  ).bind(conv.id, conv.slug, conv.pem, conv.webhook_secret, conv.client_id, conv.client_secret).run();

  const installUrl = `${conv.html_url}/installations/new`;
  const body = `<h1>GitHub App created ✅</h1>
    <p>App <code>${esc(conv.slug)}</code> (id ${conv.id}) is configured and stored.</p>
    <p><a href="${esc(installUrl)}"><b>Install it on your repos →</b></a></p>
    <p>After installing, add <code>.workbus/*.yml</code> files to those repos and they'll be scheduled by workbus.</p>
    <details><summary>Harden (optional): store credentials as Worker secrets</summary>
      <p>The App private key is currently in D1. For a stronger setup, set these as
         Worker secrets (they take precedence over D1):</p>
      <pre>wrangler secret put GITHUB_APP_ID          # ${conv.id}
wrangler secret put GITHUB_APP_PRIVATE_KEY # the .pem
wrangler secret put GITHUB_WEBHOOK_SECRET</pre>
    </details>
    <p><a href="/setup/status">setup status</a> &middot; <a href="/runs">runs</a></p>`;
  return htmlResponse(body);
}

// Diagnostic: shows whether the App is configured and lists installations.
// ?test_token=<installationId> mints a token and lists the repos it can see.
async function renderSetupStatus(env: Env, url: URL): Promise<Response> {
  const cfg = await loadAppConfig(env);
  const insts = await env.DB.prepare(`SELECT id, account_login FROM installations ORDER BY id`).all<{ id: number; account_login: string | null }>();
  let tokenTest = "";
  const testId = url.searchParams.get("test_token");
  if (testId && cfg) {
    try {
      const token = await getInstallationToken(cfg, Number.parseInt(testId, 10));
      const res = await fetch("https://api.github.com/installation/repositories", { headers: ghHeaders(`Bearer ${token}`) });
      const data = (await res.json()) as { total_count?: number; repositories?: { full_name: string }[] };
      tokenTest = `<h2>token test (installation ${esc(testId)})</h2>
        <p>minted ok; ${data.total_count ?? 0} repo(s): ${esc((data.repositories || []).map((r) => r.full_name).join(", "))}</p>`;
    } catch (error) {
      tokenTest = `<h2>token test failed</h2><pre>${esc(error instanceof Error ? error.message : String(error))}</pre>`;
    }
  }
  const body = `<h1>workbus setup status</h1>
    <p>App configured: <b>${cfg ? `yes (id ${cfg.appId}${cfg.slug ? `, ${esc(cfg.slug)}` : ""})` : "no"}</b>
       ${cfg ? "" : `&middot; <a href="/setup">run setup</a>`}</p>
    <h2>installations</h2>
    <ul>${(insts.results || []).map((i) => `<li>${i.id} — ${esc(i.account_login || "")} &middot; <a href="/setup/status?test_token=${i.id}">test token</a></li>`).join("") || "<li>none yet</li>"}</ul>
    ${tokenTest}`;
  return htmlResponse(body);
}

async function handleWebhook(env: Env, request: Request, ctx: ExecutionContext): Promise<Response> {
  const cfg = await loadAppConfig(env);
  const raw = await request.arrayBuffer();
  const sig = request.headers.get("x-hub-signature-256");
  if (!cfg?.webhookSecret || !(await verifyWebhookSignature(cfg.webhookSecret, raw, sig))) {
    return new Response("invalid signature", { status: 401 });
  }
  const event = request.headers.get("x-github-event") || "";
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  if (event === "installation" || event === "installation_repositories") {
    await handleInstallationEvent(env, payload);
  }
  // Keep the catalog fresh: repos added/removed, or a push that touches .workbus/.
  if (event === "installation_repositories" || (event === "push" && pushTouchesWorkbus(payload))) {
    ctx.waitUntil(resyncCatalog(env));
  }
  console.log("github webhook", event, (payload as { action?: string }).action || "");
  return new Response("ok");
}

function pushTouchesWorkbus(payload: Record<string, unknown>): boolean {
  const commits = (payload.commits as { added?: string[]; modified?: string[]; removed?: string[] }[]) || [];
  return commits.some((c) =>
    [...(c.added || []), ...(c.modified || []), ...(c.removed || [])].some((p) => p.startsWith(".workbus/"))
  );
}

async function handleInstallationEvent(env: Env, payload: Record<string, unknown>): Promise<void> {
  const installation = payload.installation as { id?: number; account?: { login?: string } } | undefined;
  if (!installation?.id) return;
  const action = (payload.action as string) || "";
  if (action === "deleted") {
    await env.DB.prepare(`DELETE FROM installations WHERE id = ?`).bind(installation.id).run();
    return;
  }
  await env.DB.prepare(`INSERT OR REPLACE INTO installations (id, account_login) VALUES (?, ?)`)
    .bind(installation.id, installation.account?.login ?? null)
    .run();
}

// ===========================================================================
//   Discovery: .workbus/ workflows across installed repos -> jobs
// ===========================================================================

// Walk every installation's repos, upsert repos + jobs from their .workbus/
// directories, and drop jobs whose workflow file no longer exists.
async function resyncCatalog(env: Env): Promise<{ repos: number; jobs: number }> {
  const cfg = await loadAppConfig(env);
  if (!cfg) return { repos: 0, jobs: 0 };

  const installations = await env.DB.prepare(`SELECT id FROM installations`).all<{ id: number }>();
  let repoCount = 0;
  let jobCount = 0;

  for (const inst of installations.results || []) {
    const token = await getInstallationToken(cfg, inst.id);
    const repos = await listInstallationRepos(token);
    for (const repo of repos) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO repos (id, installation_id, full_name, default_branch) VALUES (?, ?, ?, ?)`
      ).bind(repo.id, inst.id, repo.full_name, repo.default_branch).run();
      repoCount += 1;

      const specs = await readWorkbusWorkflows(token, repo.full_name, repo.default_branch);
      const seen = new Set<string>();
      for (const spec of specs) {
        const jobId = `${repo.id}:${spec.path}`;
        seen.add(spec.path);
        // Store the first cron; multi-cron workflows are noted but not yet split.
        if (spec.crons.length > 1) console.log(`job ${jobId} has ${spec.crons.length} crons; using the first`);
        await env.DB.prepare(
          `INSERT INTO jobs (id, repo_id, workflow_path, cron, manual_ok, enabled)
             VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(id) DO UPDATE SET
             cron = excluded.cron, manual_ok = excluded.manual_ok, workflow_path = excluded.workflow_path`
        ).bind(jobId, repo.id, spec.path, spec.crons[0] ?? null, spec.manualOk ? 1 : 0).run();
        jobCount += 1;
      }

      const existing = await env.DB.prepare(`SELECT id, workflow_path FROM jobs WHERE repo_id = ?`)
        .bind(repo.id).all<{ id: string; workflow_path: string }>();
      for (const j of existing.results || []) {
        if (!seen.has(j.workflow_path)) {
          await env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(j.id).run();
        }
      }
    }
  }
  return { repos: repoCount, jobs: jobCount };
}

interface JobRow {
  id: string;
  repo_id: number;
  workflow_path: string;
  cron: string | null;
  manual_ok: number;
  enabled: number;
  full_name?: string;
  default_branch?: string;
  installation_id?: number;
}

// Build a runnable Job from a discovered jobs row, minting an installation
// token. Returns the job plus its enabled flag, or undefined if the job/repo/
// app is missing (used by callers as a dispatch-time validity check).
async function buildJobFromId(env: Env, jobId: string, eventName: string): Promise<{ job: Job; enabled: boolean } | undefined> {
  const cfg = await loadAppConfig(env);
  if (!cfg) return undefined;
  const row = await env.DB.prepare(
    `SELECT j.repo_id, j.workflow_path, j.enabled, r.full_name, r.default_branch, r.installation_id
       FROM jobs j JOIN repos r ON r.id = j.repo_id
      WHERE j.id = ?`
  ).bind(jobId).first<JobRow>();
  if (!row || !row.full_name || !row.installation_id || !row.default_branch) return undefined;

  const token = await getInstallationToken(cfg, row.installation_id);
  const repoSecrets = await loadRepoSecrets(env, row.repo_id);
  return {
    enabled: row.enabled !== 0,
    job: {
      repo: row.full_name,
      ref: row.default_branch,
      workflow: row.workflow_path,
      eventName,
      githubToken: token,
      // User secrets first; GITHUB_TOKEN is authoritative and cannot be
      // overridden by a user secret of the same name.
      secrets: { ...repoSecrets, GITHUB_TOKEN: token }
    }
  };
}

// Load and decrypt a repo's user secrets into a name->value map. Returns {}
// (and logs) when the master key is absent or a value fails to decrypt.
async function loadRepoSecrets(env: Env, repoId: number): Promise<Record<string, string>> {
  if (!env.SECRETS_MASTER_KEY) return {};
  const { results } = await env.DB.prepare(
    `SELECT name, value_ref FROM secrets WHERE scope_repo_id = ?`
  ).bind(repoId).all<{ name: string; value_ref: string }>();
  const out: Record<string, string> = {};
  for (const row of results || []) {
    if (!isValidSecretName(row.name)) continue;
    try {
      out[row.name] = await decryptSecret(env.SECRETS_MASTER_KEY, row.value_ref);
    } catch (error) {
      console.log("failed to decrypt secret", row.name, error instanceof Error ? error.message : String(error));
    }
  }
  return out;
}

// ===========================================================================
//   Secrets management (repo-scoped, encrypted at rest)
// ===========================================================================

async function renderSecrets(env: Env): Promise<Response> {
  const repos = await env.DB.prepare(`SELECT id, full_name FROM repos ORDER BY full_name`).all<{ id: number; full_name: string }>();
  const secrets = await env.DB.prepare(`SELECT scope_repo_id, name FROM secrets ORDER BY name`).all<{ scope_repo_id: number; name: string }>();

  const byRepo = new Map<number, string[]>();
  for (const s of secrets.results || []) {
    const list = byRepo.get(s.scope_repo_id) || [];
    list.push(s.name);
    byRepo.set(s.scope_repo_id, list);
  }

  const repoOptions = (repos.results || []).map((r) => `<option value="${r.id}">${esc(r.full_name)}</option>`).join("");
  const repoBlocks = (repos.results || []).map((r) => {
    const names = byRepo.get(r.id) || [];
    const items = names.map((n) => `<li><code>${esc(n)}</code>
        <form method="post" action="/secrets/delete" style="display:inline">
          <input type="hidden" name="repo_id" value="${r.id}"><input type="hidden" name="name" value="${esc(n)}">
          <button type="submit">delete</button>
        </form></li>`).join("");
    return `<h3>${esc(r.full_name)}</h3><ul>${items || "<li>no secrets</li>"}</ul>`;
  }).join("");

  const warn = env.SECRETS_MASTER_KEY
    ? ""
    : `<p style="color:#cf222e"><b>SECRETS_MASTER_KEY is not set</b> — setting secrets is disabled and existing secrets can't be decrypted.</p>`;

  const body = `<h1>workbus secrets</h1>
    <p>Repo-scoped secrets, encrypted at rest, injected into that repo's <code>.workbus/</code> runs
       as <code>\${{ secrets.NAME }}</code>. Values are never shown after saving.</p>
    ${warn}
    <h2>add / update</h2>
    <form method="post" action="/secrets">
      <select name="repo_id" required>${repoOptions || `<option value="">no repos — resync first</option>`}</select>
      <input name="name" placeholder="SECRET_NAME" pattern="[A-Z_][A-Z0-9_]*" title="A-Z, 0-9, underscore; must not start with a digit" required>
      <input name="value" type="password" placeholder="value" autocomplete="off" required>
      <button type="submit"${env.SECRETS_MASTER_KEY ? "" : " disabled"}>save</button>
    </form>
    <h2>existing</h2>
    ${repoBlocks || "<p>no repos yet.</p>"}`;
  return htmlResponse(body);
}

async function handleSetSecret(env: Env, request: Request, url: URL): Promise<Response> {
  if (!env.SECRETS_MASTER_KEY) return htmlResponse(`<h1>Secrets disabled</h1><p><code>SECRETS_MASTER_KEY</code> is not set.</p>`, 400);
  const form = await request.formData();
  const repoId = Number.parseInt(String(form.get("repo_id") || ""), 10);
  const name = String(form.get("name") || "").trim();
  const value = String(form.get("value") || "");
  if (!Number.isFinite(repoId) || !isValidSecretName(name) || value === "") {
    return htmlResponse(`<h1>Invalid secret</h1><p>Name must match <code>[A-Z_][A-Z0-9_]*</code> and the value must be non-empty.</p><p><a href="/secrets">back</a></p>`, 400);
  }
  const ciphertext = await encryptSecret(env.SECRETS_MASTER_KEY, value);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO secrets (id, scope_repo_id, scope_job_id, name, value_ref) VALUES (?, ?, NULL, ?, ?)`
  ).bind(`${repoId}:${name}`, repoId, name, ciphertext).run();
  return Response.redirect(`${url.origin}/secrets`, 303);
}

async function handleDeleteSecret(env: Env, request: Request, url: URL): Promise<Response> {
  const form = await request.formData();
  const repoId = Number.parseInt(String(form.get("repo_id") || ""), 10);
  const name = String(form.get("name") || "");
  if (Number.isFinite(repoId) && name) {
    await env.DB.prepare(`DELETE FROM secrets WHERE id = ?`).bind(`${repoId}:${name}`).run();
  }
  return Response.redirect(`${url.origin}/secrets`, 303);
}

// Manual run-now of a discovered job (runs regardless of enabled). A manual run
// is a workflow_dispatch, matching how `act` selects jobs by event.
async function runDiscoveredJob(env: Env, jobId: string): Promise<StoredReport | undefined> {
  const built = await buildJobFromId(env, jobId, "workflow_dispatch");
  if (!built) return undefined;
  return runJob(env, built.job, "manual-job");
}

async function renderJobs(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT j.id, j.workflow_path, j.cron, j.manual_ok, j.enabled, r.full_name
       FROM jobs j JOIN repos r ON r.id = j.repo_id
      ORDER BY r.full_name, j.workflow_path`
  ).all<JobRow>();

  const rows = (results || []).map((j) => `<tr>
      <td>${esc(j.full_name || "")}</td>
      <td>${esc(j.workflow_path)}</td>
      <td>${j.cron ? `<code>${esc(j.cron)}</code>` : "—"}</td>
      <td>${j.manual_ok ? "✅" : "—"}</td>
      <td>${j.enabled ? "✅" : "—"}</td>
      <td><button onclick="runJob('${esc(j.id)}')">run now</button></td>
    </tr>`).join("\n");

  const body = `<h1>workbus jobs</h1>
    <p>discovered from <code>.workbus/</code> across installed repos &middot;
       <a href="/setup/resync">resync</a> &middot; <a href="/runs">runs</a></p>
    <table>
      <thead><tr><th>repo</th><th>workflow</th><th>cron</th><th>manual</th><th>enabled</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6">no jobs yet — <a href="/setup/resync">resync</a></td></tr>`}</tbody>
    </table>
    <p id="msg"></p>
    <script>
      async function runJob(id){
        document.getElementById("msg").textContent = "running " + id + "...";
        const r = await fetch("/jobs/run?id=" + encodeURIComponent(id), {method:"POST"});
        const j = await r.json().catch(()=>({}));
        document.getElementById("msg").textContent = r.ok ? ("done: " + (j.result?.status||"?") + " — see /runs") : ("error " + r.status);
      }
    </script>`;
  return htmlResponse(body);
}

// ===========================================================================
//   Dashboard auth (Sign in with GitHub via the App's OAuth)
// ===========================================================================

interface WebAuth {
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
}

async function isAppConfigured(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS x FROM app_config WHERE id = 1`).first<{ x: number }>();
  return Boolean(row);
}

// OAuth client creds + session-signing secret. The session secret is generated
// and persisted lazily on first use.
async function getWebAuth(env: Env): Promise<WebAuth | undefined> {
  const row = await env.DB.prepare(
    `SELECT client_id, client_secret, session_secret FROM app_config WHERE id = 1`
  ).first<{ client_id: string | null; client_secret: string | null; session_secret: string | null }>();
  if (!row || !row.client_id || !row.client_secret) return undefined;
  let sessionSecret = row.session_secret;
  if (!sessionSecret) {
    sessionSecret = randomToken() + randomToken();
    await env.DB.prepare(`UPDATE app_config SET session_secret = ? WHERE id = 1`).bind(sessionSecret).run();
  }
  return { clientId: row.client_id, clientSecret: row.client_secret, sessionSecret };
}

async function getSession(request: Request, env: Env): Promise<Session | undefined> {
  const wa = await getWebAuth(env);
  if (!wa) return undefined;
  const cookies = parseCookies(request.headers.get("cookie"));
  return verifySession(wa.sessionSecret, cookies.wb_session);
}

async function startLogin(env: Env, url: URL): Promise<Response> {
  const wa = await getWebAuth(env);
  if (!wa) return htmlResponse(`<h1>workbus is not set up</h1><p>Run <a href="/setup">/setup</a> first.</p>`);
  const state = randomToken();
  const redirect = `${url.origin}/login/callback`;
  const authorize = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(wa.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&state=${state}`;
  return new Response(null, {
    status: 302,
    headers: { location: authorize, "set-cookie": serializeCookie("wb_oauth_state", state, { maxAge: 600 }) }
  });
}

async function finishLogin(env: Env, url: URL, request: Request): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(request.headers.get("cookie"));
  if (!code || !state || state !== cookies.wb_oauth_state) {
    return htmlResponse(`<h1>Login failed</h1><p>Invalid state — try <a href="/login">again</a>.</p>`, 400);
  }
  const wa = await getWebAuth(env);
  if (!wa) return htmlResponse(`<h1>workbus is not set up</h1>`, 400);

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: wa.clientId, client_secret: wa.clientSecret, code, redirect_uri: `${url.origin}/login/callback` })
  });
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) return htmlResponse(`<h1>Login failed</h1><p>Could not get a token.</p>`, 400);

  const userRes = await fetch("https://api.github.com/user", { headers: ghHeaders(`Bearer ${tokenData.access_token}`) });
  const login = ((await userRes.json()) as { login?: string }).login || "";

  // Authorize: the user must share an installation with this App (i.e. belongs
  // to an org / owns the account where workbus is installed).
  const instRes = await fetch("https://api.github.com/user/installations", { headers: ghHeaders(`Bearer ${tokenData.access_token}`) });
  const userInstallations = new Set(((await instRes.json()) as { installations?: { id: number }[] }).installations?.map((i) => i.id) || []);
  const ours = await env.DB.prepare(`SELECT id FROM installations`).all<{ id: number }>();
  const allowed = (ours.results || []).some((r) => userInstallations.has(r.id));
  if (!allowed) {
    return htmlResponse(`<h1>Access denied</h1><p><code>${esc(login)}</code> is not a member of an org where workbus is installed.</p>`, 403);
  }

  const session: Session = { login, exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 };
  const token = await signSession(wa.sessionSecret, session);
  return new Response(null, {
    status: 302,
    headers: { location: "/jobs", "set-cookie": serializeCookie("wb_session", token, { maxAge: 7 * 24 * 3600 }) }
  });
}

function logout(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "/login", "set-cookie": serializeCookie("wb_session", "", { maxAge: 0 }) }
  });
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

interface RunRow {
  id: string;
  source: string | null;
  repo: string;
  ref: string | null;
  workflow: string;
  status: string;
  exit_code: number | null;
  head_sha: string | null;
  started_at: string | null;
  completed_at: string | null;
  report_key: string | null;
  log_key: string | null;
  artifact_key: string | null;
  docker_ok: number | null;
  act_ok: number | null;
  services_ok: number | null;
  findings_json: string | null;
}

async function renderRunsList(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const repo = url.searchParams.get("repo") || "";
  const status = url.searchParams.get("status") || "";

  const where: string[] = [];
  const binds: unknown[] = [];
  if (repo) { where.push("repo = ?"); binds.push(repo); }
  if (status) { where.push("status = ?"); binds.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { results } = await env.DB.prepare(
    `SELECT id, repo, workflow, status, started_at, docker_ok, act_ok, services_ok
       FROM runs ${whereSql}
       ORDER BY started_at DESC
       LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all<RunRow>();

  const rows = (results || []).map((r) => `<tr>
        <td>${esc(r.started_at || "")}</td>
        <td>${esc(r.repo || "")}</td>
        <td>${esc(r.workflow || "")}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${flag(intToBool(r.docker_ok))}</td>
        <td>${flag(intToBool(r.act_ok))}</td>
        <td>${flag(intToBool(r.services_ok))}</td>
        <td><a href="/runs/view?id=${encodeURIComponent(r.id)}">view</a></td>
      </tr>`).join("\n");

  const qs = (o: number) => {
    const p = new URLSearchParams();
    if (repo) p.set("repo", repo);
    if (status) p.set("status", status);
    p.set("limit", String(limit));
    p.set("offset", String(Math.max(0, o)));
    return `/runs?${p.toString()}`;
  };
  const nav = `<p>
      ${offset > 0 ? `<a href="${qs(offset - limit)}">&larr; newer</a>` : "newer"}
      &nbsp;|&nbsp;
      ${(results || []).length === limit ? `<a href="${qs(offset + limit)}">older &rarr;</a>` : "older"}
    </p>`;

  const body = `<h1>workbus runs</h1>
    <p>showing ${(results || []).length} run(s)${repo ? ` for <code>${esc(repo)}</code>` : ""}${status ? ` with status <code>${esc(status)}</code>` : ""}, newest first.</p>
    <table>
      <thead><tr>
        <th>started</th><th>repo</th><th>workflow</th><th>status</th>
        <th>docker</th><th>act</th><th>services</th><th></th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="8">no runs yet</td></tr>`}</tbody>
    </table>
    ${nav}`;
  return htmlResponse(body);
}

async function renderRunDetail(env: Env, id: string): Promise<Response> {
  const run = await env.DB.prepare(`SELECT * FROM runs WHERE id = ?`).bind(id).first<RunRow>();
  if (!run) return new Response("run not found", { status: 404 });

  let findings: unknown = {};
  if (run.findings_json) {
    try { findings = JSON.parse(run.findings_json); } catch { /* keep {} */ }
  }

  const logObj = run.log_key ? await env.RUN_REPORTS.get(run.log_key) : null;
  const log = logObj ? await logObj.text() : "(no log)";

  const body = `<p><a href="/runs">&larr; all runs</a></p>
    <h1>${esc(run.repo)} ${statusBadge(run.status)}</h1>
    <p>${esc(run.workflow)} @ ${esc(run.ref || "")} &middot;
       started ${esc(run.started_at || "")} &middot; exit ${run.exit_code ?? "?"}
       ${run.head_sha ? `&middot; <code>${esc(run.head_sha.slice(0, 12))}</code>` : ""}</p>
    ${run.artifact_key ? `<p>artifacts: <code>${esc(run.artifact_key)}</code> (in R2)</p>` : ""}
    <h2>findings</h2>
    <pre>${esc(JSON.stringify(findings, null, 2))}</pre>
    <h2>runner.log</h2>
    <pre>${esc(log)}</pre>`;
  return htmlResponse(body);
}

function intToBool(value: number | null): boolean | undefined {
  return value === null ? undefined : value !== 0;
}

function statusBadge(status?: string): string {
  const color = status === "success" ? "#1a7f37" : status === "failure" ? "#9a6700" : "#cf222e";
  return `<span style="color:#fff;background:${color};padding:1px 6px;border-radius:4px">${esc(status || "?")}</span>`;
}

function flag(ok?: boolean): string {
  if (ok === undefined) return "·";
  return ok ? "✅" : "❌";
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function htmlResponse(body: string, status = 200): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <title>workbus</title>
    <style>
      body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#1f2328}
      table{border-collapse:collapse;width:100%}
      th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #d0d7de}
      th{background:#f6f8fa}
      pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto;max-height:32rem}
      a{color:#0969da}
      code{background:#eff1f3;padding:1px 4px;border-radius:4px}
      nav{margin-bottom:1rem;color:#57606a}
    </style></head><body>
    <nav><a href="/jobs">jobs</a> &middot; <a href="/runs">runs</a> &middot; <a href="/secrets">secrets</a> &middot; <a href="/setup/status">setup</a> &middot; <a href="/logout">logout</a></nav>
    ${body}</body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
