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
    "ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:e2588e511d0c9457cd60df9916828b3e0955046557b790e2c38b00a03a0fd60a",
  WORKER_CORE_COMMIT: "a8a82e1e5110131f7ed739006cd1a132f30bd930",
  WORKER_CORE_VERSION: "1.18.33-bot.13-pre.28",
});
