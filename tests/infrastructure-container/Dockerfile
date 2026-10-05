FROM public.ecr.aws/docker/library/node:22-bookworm-slim
WORKDIR /app
COPY dist ./dist
COPY node_modules ./node_modules
COPY package.json ./package.json
COPY bootstrap-fixture.sh /app/railway-volume-maintenance.sh
COPY boundary-fixture.mjs /app/boundary-fixture.mjs
RUN mkdir -p /data && chmod +x /app/railway-volume-maintenance.sh && chown -R root:root /app && chmod -R a+rX,go-w /app
CMD ["node", "/app/dist/infrastructure/launcher.js"]
