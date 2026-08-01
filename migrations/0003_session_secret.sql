-- Per-deployment secret used to sign dashboard session cookies. Generated
-- lazily by the Worker (getWebAuth) if null.
ALTER TABLE app_config ADD COLUMN session_secret TEXT;
