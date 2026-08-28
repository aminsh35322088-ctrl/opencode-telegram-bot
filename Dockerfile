# Build stage
# Use AWS ECR Public's mirror of the official Node image to avoid relying on Docker Hub
# during Railway builds.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

# Runtime stage
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init ca-certificates git git-lfs curl wget unzip zip jq \
    ripgrep fd-find tree file less rsync openssh-client procps \
    && git lfs install --system \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

COPY .opencode-version ./
RUN OPENCODE_VERSION="$(tr -d '\r\n' < .opencode-version)" \
    && test -n "${OPENCODE_VERSION}" \
    && npm install -g "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force

ENV NODE_ENV=production
ENV OPENCODE_TELEGRAM_HOME=/data
ENV HOME=/data
ENV XDG_CONFIG_HOME=/data/.config
ENV XDG_DATA_HOME=/data/.local/share
ENV XDG_CACHE_HOME=/data/.cache

RUN mkdir -p /data/logs /data/run /data/.config /data/.local/share /data/.cache /app/workspace \
    && chown -R node:node /data /app
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --chown=root:root railway-entrypoint.sh ./railway-entrypoint.sh
RUN chmod +x ./railway-entrypoint.sh
ENTRYPOINT ["dumb-init", "--"]
CMD ["./railway-entrypoint.sh"]
