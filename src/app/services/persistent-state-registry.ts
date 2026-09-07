import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

/** Runtime persistence owned by the bot. User configuration lives in app-state.json. */
export const PERSISTENT_STATE = {
  application: [
    "app-state.json",
    "app-state.json.bak",
    "app-state.json.tmp",
    "telegram-topic-bindings.json",
    "telegram-topic-bindings.json.bak",
    path.join("runtime", "topics", "telegram-topic-runtime.json"),
    path.join("runtime", "topics", "telegram-topic-runtime.json.tmp"),
    "memory.json",
    "memory.json.tmp",
    path.join(".config", "opencode-telegram"),
  ],
} as const;

/**
 * Bot-owned configuration stores removed by the centralized app-state refactor.
 * OpenCode-owned state is deliberately excluded: model.json, auth, cache, and
 * OpenCode config/state must remain under OpenCode's own lifecycle.
 */
const LEGACY_APPLICATION_PATHS = [
  "settings.json",
  "settings.json.bak",
  "settings.json.tmp",
  "custom-providers.json",
  "image-ai-providers.json",
  "cloudflare-workers-ai.json",
  "providers",
  "integrations",
  "ai-role-selection.json",
  "telegram-topic-runtime.json",
  "telegram-topic-runtime.json.tmp",
];
const LEGACY_MODEL_PREFERENCE_PATH = path.join("model-preferences", "model-preferences.json");

export function getPersistentStatePaths(): string[] {
  const appHome = getRuntimePaths().appHome;
  return PERSISTENT_STATE.application.map((relativePath) => path.join(appHome, relativePath));
}

/** Remove stores superseded by app-state.json. Safe for a fresh installation and idempotent. */
export async function cleanupLegacyUserConfiguration(): Promise<void> {
  const appHome = getRuntimePaths().appHome;
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || "/data";
  const paths = [
    ...LEGACY_APPLICATION_PATHS.map((relativePath) => path.join(appHome, relativePath)),
    path.join(home, LEGACY_MODEL_PREFERENCE_PATH),
  ];
  const results = await Promise.all(paths.map(async (target) => {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return { target, ok: true };
    } catch {
      return { target, ok: false };
    }
  }));
  const failures = results.filter((item) => !item.ok).map((item) => item.target);
  if (failures.length) throw new Error(`Could not remove obsolete bot configuration: ${failures.join(", ")}`);
}

export function getPersistentStateManifest(): Record<string, readonly string[]> {
  return { application: PERSISTENT_STATE.application };
}
