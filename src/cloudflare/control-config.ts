/** Non-secret production defaults are source-controlled, not user-managed environment variables. */
export const CONTROL_DEFAULTS = Object.freeze({
  CONTROL_PLANE_URL: "https://opencode-control-plane.amin3532.workers.dev",
  MAX_WORKERS: "10",
  WORKERS_PER_PROJECT: "5",
  MAX_RAILWAY_PROJECTS: "2",
  PROVISIONING_ENABLED: "true",
  CORE_AUTO_UPDATE: "true",
  WORKER_IMAGE:
    "ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:90accf7f06a07f6e35dbcdc7487f1bc30fc9214e2805c6327345a1bf58b6a812",
  WORKER_CORE_COMMIT: "b0f9fd09d16f22051fdbecfeb5f35bda15384892",
  WORKER_CORE_VERSION: "1.18.33-bot.13-pre.31",
});
