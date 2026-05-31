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
    tar \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_x86_64.tar.gz" \
  | tar -xz -C /usr/local/bin act \
  && chmod +x /usr/local/bin/act

WORKDIR /app
COPY runner/package.json runner/package-lock.json* ./
RUN npm install --omit=dev
COPY runner/ ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
