import { Container, getContainer } from "@cloudflare/containers";

type RunStatus = "success" | "failure" | "error";

interface Env {
  ACTIONS_RUNNER: DurableObjectNamespace<ActionsRunnerContainer>;
  RUN_REPORTS: R2Bucket;
  DB: D1Database;
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

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        service: "workbus-scheduled-runner",
        repo: env.RUNNER_REPO,
        ref: env.RUNNER_REF,
        workflow: env.RUNNER_WORKFLOW,
        runs: "/runs"
      });
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      return renderRunsList(env, url);
    }

    if (request.method === "GET" && url.pathname === "/runs/view") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("missing id", { status: 400 });
      return renderRunDetail(env, id);
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const unauthorized = authorizeManualRun(request, env);
      if (unauthorized) return unauthorized;
      const stored = await runJob(env, jobFromEnv(env), "manual");
      return Response.json(stored);
    }

    if (request.method === "POST" && url.pathname === "/cdn-cgi/handler/scheduled") {
      const stored = await runJob(env, jobFromEnv(env), "local-scheduled-test");
      return Response.json(stored);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runJob(env, jobFromEnv(env), "cron", controller.cron));
  }
};

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

function authorizeManualRun(request: Request, env: Env): Response | undefined {
  if (!env.RUNNER_TRIGGER_TOKEN) return;
  const header = request.headers.get("authorization") || "";
  if (header !== `Bearer ${env.RUNNER_TRIGGER_TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }
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

function htmlResponse(body: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <title>workbus runs</title>
    <style>
      body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#1f2328}
      table{border-collapse:collapse;width:100%}
      th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #d0d7de}
      th{background:#f6f8fa}
      pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto;max-height:32rem}
      a{color:#0969da}
      code{background:#eff1f3;padding:1px 4px;border-radius:4px}
    </style></head><body>${body}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
