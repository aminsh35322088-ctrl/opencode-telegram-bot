/** Non-secret production defaults are source-controlled, not user-managed environment variables. */
export const CONTROL_DEFAULTS = Object.freeze({
  CONTROL_PLANE_URL: "https://opencode-control-plane.amin3532.workers.dev",
  MAX_WORKERS: "10",
  WORKERS_PER_PROJECT: "5",
  MAX_RAILWAY_PROJECTS: "2",
  PROVISIONING_ENABLED: "true",
  CORE_AUTO_UPDATE: "true",
  WORKER_IMAGE:
    "ghcr.io/aminsh35322088-ctrl/opencode-telegram-worker@sha256:38ba2ff08d3db6a1c4e3c720ad13c2865756b2d351b374c6b18c24f76058d939",
  WORKER_CORE_COMMIT: "2bb2df07fa69c5dfa2856b2e73d2b3b7acbced80",
  WORKER_CORE_VERSION: "1.18.33-bot.13-pre.32",
});
