import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { removeExtensionCredentials } from "./credential-vault-service.js";
import { listStoredExtensions, removeStoredExtension } from "./extension-store.js";
import type { ExtensionRecord } from "../types/extension.js";
import { listGeneratedActions, removeGeneratedActionsForExtension } from "./generated-action-store.js";

/** Runtime persistence owned by the bot. User configuration lives in app-state.json. */
export const PERSISTENT_STATE = {
  application: [
    "app-state.json",
    "app-state.json.bak",
    "app-state.json.tmp",
    path.join("runtime", "topics", "telegram-topic-bindings.json"),
    path.join("runtime", "topics", "telegram-topic-bindings.json.tmp"),
    path.join("runtime", "topics", "telegram-topic-runtime.json"),
    path.join("runtime", "topics", "telegram-topic-runtime.json.tmp"),
    path.join("runtime", "memory", "memory.json"),
    path.join("runtime", "memory", "memory.json.tmp"),
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
  "telegram-topic-bindings.json",
  "telegram-topic-bindings.json.bak",
  "telegram-topic-runtime.json",
  "telegram-topic-runtime.json.tmp",
  "memory.json",
  "memory.json.tmp",
];
const LEGACY_MODEL_PREFERENCE_PATH = path.join("model-preferences", "model-preferences.json");
const REMOVED_OMNIROUTER_PATH = "omnirouter";
const REMOVED_FREE_SOURCE_EXTENSION_IDS = [
  "internal:omnirouter",
  "integration:free-model-source:gemini",
  "integration:free-model-source:qwen",
  "integration:free-model-source:glm",
  "integration:free-model-source:ds",
  "integration:free-model-source:freebuff",
] as const;

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
    path.join(appHome, REMOVED_OMNIROUTER_PATH),
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

  // Railway used to be a hard-coded user Integration. Purge its legacy account
  // records (including tokens) during the generic persistence migration. The
  // hosting platform metadata under RAILWAY_* is unrelated and remains intact.
  const state = await readAppState();
  const patch: Record<string, unknown> = {};

  if (state.integrations && typeof state.integrations === "object" && !Array.isArray(state.integrations) && "railway" in state.integrations) {
    const integrations = { ...state.integrations };
    delete integrations.railway;
    patch.integrations = integrations;
  }

  // OmniRouter and the experimental free-source bridge were removed. Delete
  // both the old plaintext/runtime state and the retired Experimental toggle.
  if ("freeModelSources" in state) patch.freeModelSources = undefined;
  if ("freeModelSourcesRuntime" in state) patch.freeModelSourcesRuntime = undefined;
  if (state.settings && typeof state.settings === "object" && !Array.isArray(state.settings)) {
    const settings = { ...state.settings };
    if ("experimentalFreeModelSources" in settings) {
      delete settings.experimentalFreeModelSources;
      patch.settings = settings;
    }
  }
  if (Object.keys(patch).length > 0) await updateAppState(patch);

  // Skills and Plugins stay the Extension auto-install kinds. MCP records are
  // now also legitimate: they are produced by the bot-managed mcp.add/mcp.sync
  // path and own the generated Actions that mirror each server's tools. Every
  // other kind (auto-created Integration/model-provider leftovers) is still
  // purged, without touching the user's manual MCP server definitions or
  // custom-provider configuration.
  // Bot-managed MCP records are keyed exactly `mcp:<lowercased server name>` by
  // mcp-extension-service. A record that does not follow that shape is a
  // retired auto-created leftover and stays eligible for purging.
  const isManagedMcpExtension = (extension: ExtensionRecord): boolean =>
    extension.kind === "mcp"
    && extension.managed
    && extension.resource.kind === "mcp"
    && extension.id === `mcp:${extension.resource.serverName.trim().toLowerCase()}`;
  const obsoleteExtensions = (await listStoredExtensions()).filter(
    (extension) => extension.kind !== "skill" && extension.kind !== "plugin" && !isManagedMcpExtension(extension),
  );
  for (const extension of obsoleteExtensions) {
    await removeGeneratedActionsForExtension(extension.id);
    await removeStoredExtension(extension.id);
    const isCoreIntegration =
      extension.kind === "integration"
      && extension.resource.kind === "integration"
      && ["github", "tailscale"].includes(extension.resource.adapter);
    if (
      extension.kind === "mcp"
      || (extension.kind === "integration" && !isCoreIntegration)
    ) {
      await removeExtensionCredentials(extension.id);
    }
  }

  // Remove orphaned generated Actions even when the corresponding retired
  // Extension record was already deleted in an earlier deployment. Actions are
  // only orphaned when no live Extension record still owns them, so managed MCP
  // tool Actions survive startup.
  const liveExtensionIds = new Set((await listStoredExtensions()).map((extension) => extension.id));
  const generated = await listGeneratedActions();
  const retiredActionExtensionIds = new Set(
    generated
      .map((action) => action.extensionId)
      .filter((id) =>
        !liveExtensionIds.has(id)
        && (
          id.startsWith("mcp:")
          || id.startsWith("integration:")
          || id.startsWith("model-provider:")
        ),
      ),
  );
  for (const extensionId of retiredActionExtensionIds) {
    await removeGeneratedActionsForExtension(extensionId);
  }

  // Free-source and internal OmniRouter secrets lived in Credential Vault under
  // these dedicated Extension IDs. They are no longer usable and must not
  // survive the migration.
  for (const extensionId of REMOVED_FREE_SOURCE_EXTENSION_IDS) {
    await removeExtensionCredentials(extensionId);
  }

  // One final no-op write rotates app-state.json.bak from the fully cleaned
  // current state so retired OmniRouter/free-source data is not left in backup.
  await updateAppState({});
}
