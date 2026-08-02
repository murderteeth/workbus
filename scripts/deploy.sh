#!/usr/bin/env bash
# Deploy workbus. Computes a content hash of runner/ (+ Dockerfile) and passes it
# as the RUNNER_HASH build arg (via wrangler image_vars ${RUNNER_HASH}) so a
# changed runner reliably rebuilds the container image without `docker builder
# prune`. Uses immediate container rollout so the new image reaches instances in
# ~1-2 min instead of ~3-4.
set -euo pipefail
cd "$(dirname "$0")/.."

RUNNER_HASH=$(find runner Dockerfile -type f | sort | xargs sha256sum | sha256sum | cut -c1-16)
export RUNNER_HASH
echo "RUNNER_HASH=$RUNNER_HASH"

exec npx wrangler deploy --containers-rollout immediate "$@"
