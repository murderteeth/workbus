# Source Notes

Platform behavior checked against official docs on 2026-05-31:

- Cloudflare Cron Triggers use a Worker `scheduled()` handler and are configured
  in Wrangler under `[triggers]`.
- Cloudflare Containers are launched and routed from Workers through a
  Durable Object binding.
- Containers support `start()`/`fetch()` control and per-start environment
  variables.
- Container lifecycle hooks report start, stop, idle, and error events.
- R2 Worker bindings support `put()` for report and log storage.
- `act` reads GitHub workflow files and uses the Docker API to run workflow
  containers.

These docs do not guarantee privileged nested Docker support inside Cloudflare
Containers. That is why the Docker and service-container probes are first-class
prototype findings rather than assumed capabilities.
