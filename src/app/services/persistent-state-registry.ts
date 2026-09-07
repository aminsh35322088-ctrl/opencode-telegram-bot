import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

/**
 * Single source of truth for Bot-owned persistent state.
 *
 * app-state.json is the canonical container for user configuration. Legacy
 * files remain registered temporarily so Factory Reset can also clean up data
 * from pre-migration releases. Secrets remain in their existing 0600 files.
 */
export const PERSISTENT_STATE = {
  application: [
    "app-state.json",
    "app-state.json.bak",
    "app-state.json.tmp",
    "settings.json",
    "settings.json.bak",
    "settings.json.tmp",
    "custom-providers.json",
    "image-ai-providers.json",
    "cloudflare-workers-ai.json",
    "telegram-topic-bindings.json",
    "telegram-topic-bindings.json.bak",
    "telegram-topic-runtime.json",
    "telegram-topic-runtime.json.tmp",
    "memory.json",
    "memory.json.tmp",
    "providers",
    "integrations",
    path.join(".config", "opencode-telegram"),
  ],
  modelCenter: ["model-preferences", path.join(".local", "state", "opencode", "model.json")],
} as const;

export function getPersistentStatePaths(): string[] {
  const appHome = getRuntimePaths().appHome;
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || "/data";
  return [
    ...PERSISTENT_STATE.application.map((relativePath) => path.join(appHome, relativePath)),
    path.join(home, "model-preferences"),
    path.join(home, ".local", "state", "opencode", "model.json"),
  ];
}

export function getPersistentStateManifest(): Record<string, readonly string[]> {
  return {
    application: PERSISTENT_STATE.application,
    modelCenter: PERSISTENT_STATE.modelCenter,
  };
}
