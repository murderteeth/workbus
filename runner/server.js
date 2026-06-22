import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const port = Number(process.env.PORT || "8080");
const maxBodyBytes = 512 * 1024;
const maxLogBytes = 1024 * 1024;
const maxArtifactBytes = 5 * 1024 * 1024;

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/ping") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/run") {
      const request = await readJson(req);
      const result = await runWorkflow(request);
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, {
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`workbus runner listening on ${port}`);
});

// This process runs as PID 1 in the container. The kernel does NOT apply the
// default "terminate" disposition to PID 1, so without these handlers SIGTERM
// (sent by the Worker's stop()/sleepAfter) is ignored and the container never
// exits — meaning it keeps billing until the platform eventually SIGKILLs it.
// Handle the signals so the container actually scales to zero on stop.
function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function runWorkflow(request) {
  const runId = request.runId || randomUUID();
  const startedAt = new Date().toISOString();
  const workspace = await mkdtemp(path.join(tmpdir(), `workbus-${runId}-`));
  const log = new LogBuffer(maxLogBytes, Object.values(request.secrets || {}));
  const timeoutMs = Number(request.timeoutSeconds || 900) * 1000;
  const deadline = Date.now() + timeoutMs;
  const env = { ...process.env };
  const findings = {
    checkout: { ok: false },
    docker: { ok: false, requiredForAct: true },
    serviceContainers: { ok: false, skipped: !request.enableServiceProbe },
    act: { ok: false },
    secrets: { ok: false },
    logs: { ok: true },
    artifacts: { ok: false, skipped: false },
    timeout: { ok: true, seconds: request.timeoutSeconds || 900 }
  };

  let dockerProcess;
  let headSha = "";
  let artifactBundleBase64;
  let artifactBundleBytes = 0;
  let status = "failure";
  let exitCode = 1;

  try {
    validateRequest(request);
    log.line(`run_id=${runId}`);
    log.line(`repo=${request.repo} ref=${request.ref} workflow=${request.workflow}`);

    const dockerProbe = await ensureDocker({
      enabled: request.enableDockerd,
      log,
      timeoutMs: remaining(deadline, 30_000),
      env
    });
    dockerProcess = dockerProbe.process;
    if (dockerProbe.dockerHost) {
      env.DOCKER_HOST = dockerProbe.dockerHost;
    }
    findings.docker = dockerProbe.finding;

    if (findings.docker.ok) {
      findings.bakedImages = await loadBakedImages({
        env,
        log,
        timeoutMs: remaining(deadline, 120_000)
      });
    }

    if (request.enableServiceProbe && findings.docker.ok) {
      findings.serviceContainers = await probeServiceContainers({
        env,
        log,
        timeoutMs: remaining(deadline, 90_000),
        runId
      });
    }

    const repoDir = path.join(workspace, "repo");
    headSha = await checkoutRepo({
      repo: request.repo,
      ref: request.ref,
      token: request.githubToken,
      repoDir,
      log,
      timeoutMs: remaining(deadline, 120_000),
      env
    });
    findings.checkout = { ok: true, headSha };

    const workflowPath = path.join(repoDir, request.workflow);
    if (!existsSync(workflowPath)) {
      throw new Error(`workflow file not found after checkout: ${request.workflow}`);
    }

    const secretFile = path.join(workspace, "secrets.env");
    const envFile = path.join(workspace, "act.env");
    const eventFile = path.join(workspace, "event.json");
    await writeFile(secretFile, toEnvFile(request.secrets || {}), "utf8");
    await writeFile(envFile, toEnvFile({
      ACT: "true",
      CI: "true",
      GITHUB_TOKEN: request.githubToken || ""
    }), "utf8");
    await writeFile(eventFile, JSON.stringify({
      ref: request.ref,
      repository: { full_name: request.repo },
      schedule: request.cron || "",
      workflow: request.workflow
    }), "utf8");
    findings.secrets = {
      ok: true,
      injectedNames: Object.keys(request.secrets || {}).sort()
    };

    const artifactsDir = path.join(workspace, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const actArgs = [
      request.eventName || "schedule",
      "-W",
      request.workflow,
      "--eventpath",
      eventFile,
      "--secret-file",
      secretFile,
      "--env-file",
      envFile,
      "--artifact-server-path",
      artifactsDir,
      "--container-architecture",
      "linux/amd64",
      "--pull=false",
      "-P",
      "ubuntu-latest=node:22-bookworm-slim"
    ];
    if (request.job) {
      actArgs.push("-j", request.job);
    }

    const actResult = await runCommand("act", actArgs, {
      cwd: repoDir,
      env,
      log,
      timeoutMs: remaining(deadline, timeoutMs)
    });
    findings.act = {
      ok: actResult.exitCode === 0,
      exitCode: actResult.exitCode,
      timedOut: actResult.timedOut
    };
    findings.timeout.ok = !actResult.timedOut;
    exitCode = actResult.exitCode;

    const artifactResult = await bundleArtifacts({ workspace, artifactsDir, log });
    findings.artifacts = artifactResult.finding;
    artifactBundleBase64 = artifactResult.base64;
    artifactBundleBytes = artifactResult.bytes;

    status = actResult.exitCode === 0 ? "success" : "failure";
  } catch (error) {
    status = "error";
    findings.error = {
      message: error instanceof Error ? error.message : String(error)
    };
    log.line(`error=${findings.error.message}`);
  } finally {
    if (dockerProcess) {
      try {
        process.kill(-dockerProcess.pid, "SIGTERM");
      } catch {}
    }
    await rm(workspace, { recursive: true, force: true });
  }

  const completedAt = new Date().toISOString();
  return {
    runId,
    repo: request.repo,
    ref: request.ref,
    workflow: request.workflow,
    eventName: request.eventName || "schedule",
    startedAt,
    completedAt,
    status,
    exitCode,
    headSha,
    log: log.text(),
    logSha256: sha256(log.text()),
    findings,
    artifactBundleBase64,
    artifactBundleBytes
  };
}

async function ensureDocker({ enabled, env, log, timeoutMs }) {
  const finding = {
    ok: false,
    mode: "none",
    requiredForAct: true,
    message: ""
  };

  const existing = await runCommand("docker", ["version", "--format", "{{json .}}"], {
    env,
    log,
    timeoutMs: Math.min(timeoutMs, 10_000),
    check: false
  });
  if (existing.exitCode === 0) {
    finding.ok = true;
    finding.mode = "existing-docker-host";
    return { finding };
  }

  if (!enabled) {
    finding.message = "No Docker API detected and RUNNER_ENABLE_DOCKERD is disabled.";
    return { finding };
  }

  const dockerDir = path.join(tmpdir(), "workbus-docker");
  await mkdir(dockerDir, { recursive: true });
  const dockerHost = `unix://${path.join(dockerDir, "docker.sock")}`;
  const dockerd = spawn("dockerd", [
    "--host",
    dockerHost,
    "--data-root",
    path.join(dockerDir, "data"),
    "--exec-root",
    path.join(dockerDir, "exec"),
    "--pidfile",
    path.join(dockerDir, "docker.pid"),
    "--iptables=false"
  ], {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  dockerd.stdout.on("data", (chunk) => log.write(chunk));
  dockerd.stderr.on("data", (chunk) => log.write(chunk));

  const dockerEnv = { ...env, DOCKER_HOST: dockerHost };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runCommand("docker", ["version", "--format", "{{json .Server.Version}}"], {
      env: dockerEnv,
      log,
      timeoutMs: 5_000,
      check: false
    });
    if (result.exitCode === 0) {
      finding.ok = true;
      finding.mode = "inner-dockerd";
      finding.message = "dockerd started inside the Cloudflare Container.";
      return { finding, process: dockerd, dockerHost };
    }
    await sleep(1000);
  }

  finding.message = "dockerd did not become ready. This usually means nested Docker needs privileges unavailable to the container runtime.";
  return { finding, process: dockerd, dockerHost };
}

async function loadBakedImages({ env, log, timeoutMs }) {
  const dir = "/opt/runner-images";
  if (!existsSync(dir)) {
    return { ok: false, skipped: true, message: "no baked image directory" };
  }
  const tars = (await readdir(dir)).filter((f) => f.endsWith(".tar"));
  if (tars.length === 0) {
    return { ok: false, skipped: true, message: "no baked image tarballs" };
  }
  const loaded = [];
  for (const tar of tars) {
    const result = await runCommand("docker", ["load", "-i", path.join(dir, tar)], {
      env,
      log,
      timeoutMs: Math.min(timeoutMs, 90_000),
      check: false
    });
    if (result.exitCode === 0) loaded.push(tar);
  }
  return { ok: loaded.length > 0, loaded };
}

async function probeServiceContainers({ env, log, timeoutMs, runId }) {
  const network = `workbus-${runId}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 60);
  const service = `${network}-svc`;
  const finding = { ok: false, network, message: "" };

  try {
    await runCommand("docker", ["network", "create", network], { env, log, timeoutMs: 20_000 });
    await runCommand("docker", ["run", "-d", "--name", service, "--network", network, "alpine:3.20", "sleep", "60"], {
      env,
      log,
      timeoutMs: Math.min(timeoutMs, 60_000)
    });
    const ping = await runCommand("docker", ["run", "--rm", "--network", network, "alpine:3.20", "ping", "-c", "1", service], {
      env,
      log,
      timeoutMs: Math.min(timeoutMs, 60_000),
      check: false
    });
    finding.ok = ping.exitCode === 0;
    finding.message = finding.ok ? "Docker networked service containers are reachable." : "Service container networking probe failed.";
    return finding;
  } catch (error) {
    finding.message = error instanceof Error ? error.message : String(error);
    return finding;
  } finally {
    await runCommand("docker", ["rm", "-f", service], { env, log, timeoutMs: 10_000, check: false });
    await runCommand("docker", ["network", "rm", network], { env, log, timeoutMs: 10_000, check: false });
  }
}

async function checkoutRepo({ repo, ref, token, repoDir, log, timeoutMs, env }) {
  await mkdir(repoDir, { recursive: true });
  await runCommand("git", ["init"], { cwd: repoDir, env, log, timeoutMs: 10_000 });
  await runCommand("git", ["remote", "add", "origin", `https://github.com/${repo}.git`], {
    cwd: repoDir,
    env,
    log,
    timeoutMs: 10_000
  });
  const fetchArgs = ["fetch", "--depth=1", "origin", ref];
  const gitEnv = { ...env };
  const command = token
    ? ["-c", `http.https://github.com/${repo}.extraheader=AUTHORIZATION: bearer ${token}`, ...fetchArgs]
    : fetchArgs;
  await runCommand("git", command, { cwd: repoDir, env: gitEnv, log, timeoutMs });
  await runCommand("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: repoDir, env, log, timeoutMs: 30_000 });
  const rev = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: repoDir,
    env,
    log,
    timeoutMs: 10_000,
    captureStdout: true
  });
  return rev.stdout.trim();
}

async function bundleArtifacts({ workspace, artifactsDir, log }) {
  const tarPath = path.join(workspace, "artifacts.tgz");
  const result = await runCommand("tar", ["-czf", tarPath, "-C", artifactsDir, "."], {
    log,
    timeoutMs: 30_000,
    check: false
  });
  if (result.exitCode !== 0) {
    return { finding: { ok: false, message: "artifact tar failed" }, bytes: 0 };
  }
  const info = await stat(tarPath);
  if (info.size > maxArtifactBytes) {
    return {
      finding: { ok: false, skipped: true, bytes: info.size, message: "artifact bundle exceeds prototype inline limit" },
      bytes: info.size
    };
  }
  const bytes = await readFile(tarPath);
  return {
    finding: { ok: true, bytes: info.size },
    base64: bytes.toString("base64"),
    bytes: info.size
  };
}

async function runCommand(command, args, options = {}) {
  const started = Date.now();
  const timeoutMs = Math.max(1000, options.timeoutMs || 60_000);
  const log = options.log || { line() {}, write() {} };
  const display = `${command} ${args.map(shellQuote).join(" ")}`;
  log.line(`$ ${display}`);

  return await new Promise((resolve, reject) => {
    let stdout = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 5000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (options.captureStdout) stdout += chunk.toString();
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => log.write(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (options.check === false) {
        resolve({ exitCode: 127, timedOut, stdout, durationMs: Date.now() - started, error: error.message });
      } else {
        reject(error);
      }
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const result = { exitCode: exitCode ?? 1, timedOut, stdout, durationMs: Date.now() - started };
      if (result.exitCode !== 0 && options.check !== false) {
        reject(new Error(`${display} failed with exit code ${result.exitCode}${timedOut ? " after timeout" : ""}`));
      } else {
        resolve(result);
      }
    });
  });
}

function validateRequest(request) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repo || "")) {
    throw new Error("repo must be owner/name");
  }
  if (!request.ref) throw new Error("ref is required");
  // Accept GitHub Actions workflows (.github/workflows/) and workbus-owned
  // workflows (.workbus/). Moving a file into .workbus/ is how a repo opts a
  // workflow into being run by workbus instead of GitHub Actions.
  if (!/^(\.github\/workflows|\.workbus)\/[^/]+\.(ya?ml)$/.test(request.workflow || "")) {
    throw new Error("workflow must be a .github/workflows/*.yml or .workbus/*.yml file");
  }
}

function toEnvFile(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, "\\n")}`)
    .join("\n") + "\n";
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function remaining(deadline, cap) {
  return Math.max(1000, Math.min(cap, deadline - Date.now()));
}

function shellQuote(value) {
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LogBuffer {
  constructor(limit, masks) {
    this.limit = limit;
    this.masks = masks.filter(Boolean).map(String);
    this.buffer = "";
    this.truncated = false;
  }

  line(value) {
    this.write(`${value}\n`);
  }

  write(chunk) {
    let value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    for (const mask of this.masks) {
      value = value.split(mask).join("***");
    }
    this.buffer += value;
    if (this.buffer.length > this.limit) {
      this.buffer = this.buffer.slice(this.buffer.length - this.limit);
      this.truncated = true;
    }
  }

  text() {
    return this.truncated ? `[log truncated to last ${this.limit} bytes]\n${this.buffer}` : this.buffer;
  }
}
