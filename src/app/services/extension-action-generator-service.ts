import type { ExtensionRecord } from "../types/extension.js";
import { registerGeneratedActionPack } from "./generated-action-store.js";

function namespace(value: string): string {
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "") || "extension";
}

export async function generateExtensionActions(extension: ExtensionRecord): Promise<number> {
  if (extension.resource.kind !== "skill") return 0;

  const ns = namespace(extension.name);
  const records = await registerGeneratedActionPack(extension.id, [{
    id: `${ns}.load`,
    tool: "skill",
    action: "load",
    category: "skill",
    description: `Load the installed ${extension.name} skill.`,
    invocation: {
      kind: "native-tool",
      tool: "skill",
      arguments: { name: extension.resource.skillName },
    },
  }]);
  return records.length;
}
