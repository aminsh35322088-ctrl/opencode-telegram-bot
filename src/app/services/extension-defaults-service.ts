import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { getStoredExtension, saveStoredExtension } from "./extension-store.js";

const MIGRATION_KEY = "extensionDefaultsMigration";
const MIGRATION_VERSION = 1;

export const SUPERPOWERS_EXTENSION_ID = "plugin:superpowers";
export const SUPERPOWERS_PLUGIN_SPECIFIER =
  "superpowers@git+https://github.com/obra/superpowers.git#v6.4.2";

function migrationVersion(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const version = (value as Record<string, unknown>).version;
  return typeof version === "number" && Number.isInteger(version) ? version : 0;
}

export async function migrateBundledExtensionsToManagedState(): Promise<{ seeded: number }> {
  const state = await readAppState();
  if (migrationVersion(state[MIGRATION_KEY]) >= MIGRATION_VERSION) return { seeded: 0 };

  let seeded = 0;
  const existing = await getStoredExtension(SUPERPOWERS_EXTENSION_ID);
  if (!existing) {
    const now = new Date().toISOString();
    await saveStoredExtension({
      id: SUPERPOWERS_EXTENSION_ID,
      name: "Superpowers",
      kind: "plugin",
      source: SUPERPOWERS_PLUGIN_SPECIFIER,
      purpose: "Reusable planning, debugging, testing, and software-development skills for OpenCode.",
      authType: "none",
      credentialSchemas: [],
      resource: { kind: "plugin", specifier: SUPERPOWERS_PLUGIN_SPECIFIER },
      createdAt: now,
      updatedAt: now,
      managed: true,
    });
    seeded = 1;
  }

  // The marker makes removal durable: if the user removes Superpowers later,
  // startup must not silently recreate it.
  await updateAppState({ [MIGRATION_KEY]: { version: MIGRATION_VERSION } });
  return { seeded };
}
