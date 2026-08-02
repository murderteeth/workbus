-- GitHub App credentials for this self-hosted deployment (single row).
--
-- Written by the /setup manifest flow so the App works immediately. For a more
-- secure setup the same values can be provided as Worker secrets
-- (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_WEBHOOK_SECRET), which take
-- precedence over this row (see loadAppConfig).

CREATE TABLE IF NOT EXISTS app_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  app_id         INTEGER NOT NULL,
  slug           TEXT,
  private_key    TEXT NOT NULL,
  webhook_secret TEXT,
  client_id      TEXT,
  client_secret  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
