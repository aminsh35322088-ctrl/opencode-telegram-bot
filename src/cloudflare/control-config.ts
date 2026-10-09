/** Non-secret production defaults are source-controlled, not user-managed environment variables. */
export const CONTROL_DEFAULTS = Object.freeze({
  CONTROL_PLANE_URL: "https://opencode-control-plane.amin3532.workers.dev",
  RAILWAY_WORKSPACE_ID: "df47876f-4c37-4a4d-89c7-407ec111227d",
  MAX_WORKERS: "10",
  WORKERS_PER_PROJECT: "5",
  MAX_RAILWAY_PROJECTS: "2",
  PROVISION_ON_TOPIC_CREATE: "true",
  PROVISIONING_ENABLED: "true",
  WORKER_IMAGE:
    "ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:55f6edd11bf3523404a534d5a860955dd58fc0385ca77098b796b4c97a0a997c",
  WORKER_CORE_COMMIT: "0f4a9365f71b9b51c3969e6584fee821b97ce9ba",
  WORKER_CORE_VERSION: "1.18.33-bot.13-pre.27",
});
