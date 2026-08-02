-- workbus schema.
--
-- `runs` is the run-history table the /runs UI reads (M2). The other tables
-- (installations / repos / jobs / secrets) are the control-plane model for the
-- GitHub App + .workbus/ discovery + scheduler (M3-M6); they are created now so
-- the schema is stable, but are not yet populated.

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,          -- runId
  source        TEXT,                      -- manual | cron | local-scheduled-test | ...
  repo          TEXT NOT NULL,             -- owner/name
  ref           TEXT,
  workflow      TEXT NOT NULL,             -- .workbus/<file>.yml
  status        TEXT NOT NULL,             -- success | failure | error
  exit_code     INTEGER,
  head_sha      TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  report_key    TEXT,                      -- R2 key for report.json
  log_key       TEXT,                      -- R2 key for runner.log
  artifact_key  TEXT,                      -- R2 key for artifacts.tgz (nullable)
  docker_ok     INTEGER,                   -- 0/1/null, from findings
  act_ok        INTEGER,
  services_ok   INTEGER,
  findings_json TEXT,                       -- full findings object (small)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_repo       ON runs (repo);
CREATE INDEX IF NOT EXISTS idx_runs_status     ON runs (status);

-- Control-plane scaffolding (populated in M3-M6).
CREATE TABLE IF NOT EXISTS installations (
  id            INTEGER PRIMARY KEY,       -- GitHub installation id
  account_login TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS repos (
  id              INTEGER PRIMARY KEY,     -- GitHub repo id
  installation_id INTEGER REFERENCES installations(id),
  full_name       TEXT NOT NULL,           -- owner/name
  default_branch  TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,          -- stable: repo_id + workflow_path
  repo_id       INTEGER REFERENCES repos(id),
  workflow_path TEXT NOT NULL,             -- .workbus/<file>.yml
  cron          TEXT,
  manual_ok     INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   TEXT,
  next_run_at   TEXT
);

CREATE TABLE IF NOT EXISTS secrets (
  id            TEXT PRIMARY KEY,
  scope_repo_id INTEGER,                   -- repo-scoped, or
  scope_job_id  TEXT,                      -- job-scoped
  name          TEXT NOT NULL,
  value_ref     TEXT NOT NULL              -- Secrets Store ref or ciphertext
);
