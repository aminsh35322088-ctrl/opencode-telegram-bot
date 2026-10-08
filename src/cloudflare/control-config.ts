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
    "ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:6faae202026012b61db18073044fed2e441a277875d72ecc23bdfd484b7511c6",
  WORKER_CORE_COMMIT: "56106d84f1c5b8c050241141d938fe1f185dc94f",
  WORKER_CORE_VERSION: "1.18.33-bot.13-pre.24",
});
