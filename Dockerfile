FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init ca-certificates curl wget git git-lfs unzip zip jq ripgrep fd-find tree file less rsync openssh-client procps strace ltrace gdb lsof iproute2 dnsutils iputils-ping tmux htop fzf python3 python3-pip python3-venv sqlite3 build-essential pkg-config ffmpeg imagemagick libx11-6 libxfixes3 libglib2.0-0 libpulse0 libxkbcommon0 libxtst6 libopus0 libxcb1 libxcb-shm0 libxcb-randr0 libvpx7 libaom3 libyuv0 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libdbus-1-3 libunwind8 libx11-xcb1 libxext6 libxdo3 && git lfs install --system && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*
COPY .opencode-version ./
RUN OPENCODE_VERSION="$(tr -d '\r\n' < .opencode-version)" && test -n "${OPENCODE_VERSION}" && npm install -g "opencode-ai@${OPENCODE_VERSION}" && npm install -g "@playwright/cli@0.1.18" && RAILWAY_VERSION="$(npm view @railway/cli version 2>/dev/null)" && curl -fsSL "https://github.com/railwayapp/cli/releases/download/v${RAILWAY_VERSION}/railway-v${RAILWAY_VERSION}-x86_64-unknown-linux-gnu.tar.gz" | tar -xz -C /usr/local/bin/ railway && chmod +x /usr/local/bin/railway && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright playwright-cli install-browser chromium --with-deps && npm cache clean --force
ENV NODE_ENV=production OPENCODE_TELEGRAM_HOME=/data OPENCODE_HOME=/data/opencode HOME=/data XDG_CONFIG_HOME=/data/.config XDG_DATA_HOME=/data/.local/share XDG_CACHE_HOME=/data/.cache OPEN_BROWSER_ROOTS=/data/workspace PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright OPENCODE_EXPERIMENTAL_LSP_TOOL=true OPENCODE_DATA_VOLUME_BUDGET_MB=500 OPENCODE_DATA_VOLUME_WARN_MB=150 OPENCODE_DATA_VOLUME_CRITICAL_MB=100
RUN mkdir -p /data/logs /data/run /data/.config /data/.local/share /data/.cache /data/opencode /data/workspace && chown -R node:node /data /app
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --chown=node:node AGENTS.md ./AGENTS.md
COPY --chown=node:node docs/release-notes ./docs/release-notes
COPY --chown=node:node opencode.json ./opencode.json
COPY --chown=node:node .opencode/tools ./.opencode/tools
COPY --chown=root:root rustdesk-bridge.lock ./rustdesk-bridge.lock
COPY --chown=root:root railway-entrypoint.sh ./railway-entrypoint.sh
COPY --chown=root:root railway-volume-maintenance.sh ./railway-volume-maintenance.sh
COPY --chown=root:root scripts/opencode-db-maintenance.mjs ./scripts/opencode-db-maintenance.mjs
RUN chmod +x ./railway-entrypoint.sh ./railway-volume-maintenance.sh
ENTRYPOINT ["dumb-init", "--"]
CMD ["./railway-volume-maintenance.sh"]
