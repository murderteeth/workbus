// Discovery: enumerate an installation's repos and the schedulable workflows in
// their `.workbus/` directories.

import yaml from "js-yaml";
import { ghHeaders } from "./github";

const GH_API = "https://api.github.com";

export interface RepoInfo {
  id: number;
  full_name: string;
  default_branch: string;
}

export interface WorkflowSpec {
  path: string; // .workbus/<file>.yml
  crons: string[];
  manualOk: boolean;
}

export async function listInstallationRepos(token: string): Promise<RepoInfo[]> {
  const repos: RepoInfo[] = [];
  for (let page = 1; ; page += 1) {
    const res = await fetch(`${GH_API}/installation/repositories?per_page=100&page=${page}`, {
      headers: ghHeaders(`Bearer ${token}`)
    });
    if (!res.ok) throw new Error(`list installation repos ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { repositories: RepoInfo[] };
    for (const r of data.repositories) {
      repos.push({ id: r.id, full_name: r.full_name, default_branch: r.default_branch });
    }
    if (data.repositories.length < 100) break;
  }
  return repos;
}

// Read `.workbus/*.yml` in a repo and parse each into a schedulable spec.
export async function readWorkbusWorkflows(token: string, fullName: string, ref: string): Promise<WorkflowSpec[]> {
  const res = await fetch(`${GH_API}/repos/${fullName}/contents/.workbus?ref=${encodeURIComponent(ref)}`, {
    headers: ghHeaders(`Bearer ${token}`)
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`list .workbus in ${fullName} ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const entries = (await res.json()) as { name: string; path: string; type: string }[];
  const specs: WorkflowSpec[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || !/\.ya?ml$/.test(entry.name)) continue;
    const spec = await fetchAndParse(token, fullName, entry.path, ref);
    if (spec) specs.push(spec);
  }
  return specs;
}

async function fetchAndParse(token: string, fullName: string, path: string, ref: string): Promise<WorkflowSpec | undefined> {
  const res = await fetch(`${GH_API}/repos/${fullName}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
    headers: { ...ghHeaders(`Bearer ${token}`), accept: "application/vnd.github.raw+json" }
  });
  if (!res.ok) return undefined;
  const text = await res.text();
  return parseWorkflow(path, text);
}

// Exported for unit testing. JSON_SCHEMA keeps `on:` as a string key instead of
// resolving the YAML 1.1 boolean `on` -> true.
export function parseWorkflow(path: string, text: string): WorkflowSpec | undefined {
  let doc: unknown;
  try {
    doc = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object") return undefined;
  const on = (doc as Record<string, unknown>).on;

  const crons: string[] = [];
  let manualOk = false;

  if (on && typeof on === "object" && !Array.isArray(on)) {
    const onObj = on as Record<string, unknown>;
    const schedule = onObj.schedule;
    if (Array.isArray(schedule)) {
      for (const item of schedule) {
        const cron = (item as { cron?: unknown })?.cron;
        if (typeof cron === "string" && cron.trim()) crons.push(cron.trim());
      }
    }
    if ("workflow_dispatch" in onObj) manualOk = true;
  } else if (Array.isArray(on)) {
    if (on.includes("workflow_dispatch")) manualOk = true;
  } else if (typeof on === "string") {
    if (on === "workflow_dispatch") manualOk = true;
  }

  // Only workflows workbus can actually trigger (scheduled and/or manual).
  if (crons.length === 0 && !manualOk) return undefined;
  return { path, crons, manualOk };
}
