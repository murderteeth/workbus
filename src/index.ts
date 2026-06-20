import { Container, getContainer } from "@cloudflare/containers";

type RunStatus = "success" | "failure" | "error";

interface Env {
  ACTIONS_RUNNER: DurableObjectNamespace<ActionsRunnerContainer>;
  RUN_REPORTS: R2Bucket;
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

export class ActionsRunnerContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "2m";
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
      return renderRunsList(env);
    }

    if (request.method === "GET" && url.pathname === "/runs/view") {
      const key = url.searchParams.get("key");
      if (!key) return new Response("missing key", { status: 400 });
      return renderRunDetail(env, key);
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const unauthorized = authorizeManualRun(request, env);
      if (unauthorized) return unauthorized;
      const stored = await runOnce(env, "manual");
      return Response.json(stored);
    }

    if (request.method === "POST" && url.pathname === "/cdn-cgi/handler/scheduled") {
      const stored = await runOnce(env, "local-scheduled-test");
      return Response.json(stored);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runOnce(env, "cron", controller.cron));
  }
};

async function runOnce(env: Env, source: string, cron?: string): Promise<StoredReport> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const timeoutSeconds = clampInt(env.RUNNER_TIMEOUT_SECONDS, 60, 3600, 900);
  let result: RunnerResult;

  try {
    const requestBody = {
      runId,
      source,
      cron,
      repo: env.RUNNER_REPO,
      ref: env.RUNNER_REF,
      workflow: env.RUNNER_WORKFLOW,
      eventName: env.RUNNER_EVENT_NAME || "schedule",
      job: env.RUNNER_JOB || undefined,
      timeoutSeconds,
      enableDockerd: parseBool(env.RUNNER_ENABLE_DOCKERD, true),
      enableServiceProbe: parseBool(env.RUNNER_ENABLE_SERVICE_PROBE, true),
      githubToken: env.GITHUB_TOKEN || "",
      secrets: buildSecretMap(env)
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("runner timeout"), (timeoutSeconds + 30) * 1000);

    const container = getContainer(env.ACTIONS_RUNNER, "scheduled-runner");
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
      repo: env.RUNNER_REPO,
      ref: env.RUNNER_REF,
      workflow: env.RUNNER_WORKFLOW,
      eventName: env.RUNNER_EVENT_NAME || "schedule",
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
  }

  const stored = await storeReport(env, result);
  await Promise.allSettled([
    notifyGitHub(env, result, stored),
    notifySlack(env, result, stored)
  ]);
  return stored;
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

async function renderRunsList(env: Env): Promise<Response> {
  const prefix = (env.RUNNER_R2_PREFIX || "runs").replace(/^\/+|\/+$/g, "") + "/";
  const listed = await env.RUN_REPORTS.list({ prefix, limit: 1000 });
  const reportKeys = listed.objects
    .map((o) => o.key)
    .filter((k) => k.endsWith("/report.json"))
    .sort((a, b) => runIdOf(b).localeCompare(runIdOf(a)))
    .slice(0, 50);

  const reports = await Promise.all(
    reportKeys.map(async (key) => {
      const obj = await env.RUN_REPORTS.get(key);
      if (!obj) return undefined;
      try {
        return { key, report: (await obj.json()) as RunnerResult };
      } catch {
        return undefined;
      }
    })
  );

  const rows = reports
    .filter((r): r is { key: string; report: RunnerResult } => Boolean(r))
    .map(({ key, report }) => {
      const f = (report.findings || {}) as Record<string, { ok?: boolean }>;
      return `<tr>
        <td>${esc(report.startedAt || "")}</td>
        <td>${esc(report.repo || "")}</td>
        <td>${esc(report.workflow || "")}</td>
        <td>${statusBadge(report.status)}</td>
        <td>${flag(f.docker?.ok)}</td>
        <td>${flag(f.act?.ok)}</td>
        <td>${flag(f.serviceContainers?.ok)}</td>
        <td><a href="/runs/view?key=${encodeURIComponent(key)}">view</a></td>
      </tr>`;
    })
    .join("\n");

  const body = `<h1>workbus runs</h1>
    <p>${reports.filter(Boolean).length} run(s), newest first.</p>
    <table>
      <thead><tr>
        <th>started</th><th>repo</th><th>workflow</th><th>status</th>
        <th>docker</th><th>act</th><th>services</th><th></th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="8">no runs yet</td></tr>`}</tbody>
    </table>`;
  return htmlResponse(body);
}

async function renderRunDetail(env: Env, reportKey: string): Promise<Response> {
  const reportObj = await env.RUN_REPORTS.get(reportKey);
  if (!reportObj) return new Response("run not found", { status: 404 });
  const report = (await reportObj.json()) as RunnerResult;

  const logKey = reportKey.replace(/report\.json$/, "runner.log");
  const logObj = await env.RUN_REPORTS.get(logKey);
  const log = logObj ? await logObj.text() : "(no log)";

  const artifactKey = reportKey.replace(/report\.json$/, "artifacts.tgz");
  const hasArtifact = Boolean(await env.RUN_REPORTS.head(artifactKey));

  const body = `<p><a href="/runs">&larr; all runs</a></p>
    <h1>${esc(report.repo || "")} ${statusBadge(report.status)}</h1>
    <p>${esc(report.workflow || "")} @ ${esc(report.ref || "")} &middot;
       started ${esc(report.startedAt || "")} &middot; exit ${report.exitCode}
       ${report.headSha ? `&middot; <code>${esc(report.headSha.slice(0, 12))}</code>` : ""}</p>
    ${hasArtifact ? `<p>artifacts: <code>${esc(artifactKey)}</code> (in R2)</p>` : ""}
    <h2>findings</h2>
    <pre>${esc(JSON.stringify(report.findings ?? {}, null, 2))}</pre>
    <h2>runner.log</h2>
    <pre>${esc(log)}</pre>`;
  return htmlResponse(body);
}

function runIdOf(reportKey: string): string {
  const parts = reportKey.split("/");
  return parts[parts.length - 2] || reportKey;
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
