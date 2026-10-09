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
    "ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:08fa4da80d7760cf68f10c677fbcad710ce51d49c19521a36ef243899839745b",
  WORKER_CORE_COMMIT: "aae8935114a8a05e7d6ec57c9c1e35dd6065511e",
  WORKER_CORE_VERSION: "1.18.33-bot.13-pre.25",
});
