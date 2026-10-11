/** Non-secret production defaults are source-controlled, not user-managed environment variables. */
export const CONTROL_DEFAULTS = Object.freeze({
  CONTROL_PLANE_URL: "https://opencode-control-plane.amin3532.workers.dev",
  MAX_WORKERS: "10",
  WORKERS_PER_PROJECT: "5",
  MAX_RAILWAY_PROJECTS: "2",
  PROVISIONING_ENABLED: "true",
  CORE_AUTO_UPDATE: "true",
  WORKER_IMAGE:
    "ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:9f7d7386a950f91215f2aa53255118bd76656214024c0a49f7904c0699dc8698",
  WORKER_CORE_COMMIT: "70407db6bcca92e64544856bdf5a0925aaf21b0c",
  WORKER_CORE_VERSION: "1.18.33-bot.13-pre.33",
});
