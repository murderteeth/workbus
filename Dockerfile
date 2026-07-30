FROM node:22-bookworm

ARG ACT_VERSION=0.2.88

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    docker.io \
    git \
    jq \
    openssh-client \
    skopeo \
    tar \
  && rm -rf /var/lib/apt/lists/*

# Runner image used to map `ubuntu-latest`. A small Debian (Bookworm) base
# instead of the ~1GB Ubuntu act image, which would not pull in-window.
ARG RUNNER_IMAGE=node:22-bookworm-slim

RUN curl -fsSL "https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_x86_64.tar.gz" \
  | tar -xz -C /usr/local/bin act \
  && chmod +x /usr/local/bin/act

# Pre-seed act's config so it never enters the first-run interactive image
# picker (which hits EOF on non-TTY stdin and aborts).
RUN mkdir -p /root/.config/act \
  && printf -- '-P ubuntu-latest=%s\n--pull=false\n' "$RUNNER_IMAGE" \
     > /root/.config/act/actrc

# Bake the runner image into the container as a docker-archive tarball so the
# inner dockerd loads it at runtime (no network pull). skopeo pulls without a
# daemon at build time; runner/server.js `docker load`s it before invoking act.
RUN mkdir -p /opt/runner-images \
  && skopeo copy --override-os linux --override-arch amd64 \
       "docker://${RUNNER_IMAGE}" \
       "docker-archive:/opt/runner-images/runner.tar:${RUNNER_IMAGE}"

WORKDIR /app
COPY runner/package.json runner/package-lock.json* ./
RUN npm install --omit=dev

# Reliably rebuild the runner COPY when runner/ content changes. BuildKit's COPY
# content-hash cache is occasionally stale (ships an image missing the change);
# RUNNER_HASH is a hash of runner/ set by scripts/deploy.sh, and changing this
# RUN layer forces the COPY below to re-read the build context.
ARG RUNNER_HASH=dev
RUN echo "runner ${RUNNER_HASH}"
COPY runner/ ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
