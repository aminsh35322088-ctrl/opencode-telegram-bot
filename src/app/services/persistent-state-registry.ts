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
    "telegram-topic-runtime.json",
    "telegram-topic-runtime.json.tmp",
    "memory.json",
    "memory.json.tmp",
    path.join(".config", "opencode-telegram"),
  ],
} as const;

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
];
const LEGACY_HOME_PATHS = [
  path.join("model-preferences", "model-preferences.json"),
  path.join(".local", "state", "opencode", "model.json"),
];

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
    ...LEGACY_HOME_PATHS.map((relativePath) => path.join(home, relativePath)),
  ];
  await Promise.all(paths.map((target) => fs.rm(target, { recursive: true, force: true }).catch(() => {})));
}

export function getPersistentStateManifest(): Record<string, readonly string[]> {
  return { application: PERSISTENT_STATE.application };
}