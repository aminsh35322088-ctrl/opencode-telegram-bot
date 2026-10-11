FROM tailscale/tailscale:v1.102.4 AS tailscale

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
ENV NODE_ENV=production OPENCODE_TELEGRAM_HOME=/data HOME=/data XDG_CONFIG_HOME=/data/.config XDG_DATA_HOME=/data/.local/share XDG_CACHE_HOME=/data/.cache
RUN mkdir -p /data/logs /data/run /data/.config /data/.local/share /data/.cache /data/workspace && chown -R node:node /data /app
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
RUN chown -R root:root /app && chmod -R a+rX,go-w /app
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "/app/dist/infrastructure/launcher.js"]
