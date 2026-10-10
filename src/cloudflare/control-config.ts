/** Non-secret production defaults are source-controlled, not user-managed environment variables. */
export const CONTROL_DEFAULTS = Object.freeze({
  CONTROL_PLANE_URL: "https://opencode-control-plane.amin3532.workers.dev",
  MAX_WORKERS: "10",
  WORKERS_PER_PROJECT: "5",
  MAX_RAILWAY_PROJECTS: "2",
  PROVISIONING_ENABLED: "true",
  WORKER_IMAGE:
    "ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:d6b3c375cac23e115043b919d255bddc5c9d9c8699791ec48a57d7108b211736",
  WORKER_CORE_COMMIT: "f59b4ce0dfed4b4cec5f6fc58673e58e3b3adef4",
  WORKER_CORE_VERSION: "1.18.33-bot.13-pre.30",
});
