import { createHash } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { getActiveGithubAccount } from "../../app/services/github-integration-service.js";
import {
  getExtensionInfo,
  listExtensions,
} from "../../app/services/extension-registry-service.js";
import { listGeneratedActions } from "../../app/services/generated-action-store.js";

export const SETTINGS_GITHUB_CALLBACK = "settings:github";
export const SETTINGS_EXTENSIONS_CALLBACK = "settings:extensions";
export const SETTINGS_ACTIONS_CALLBACK = "settings:actions";
export const SETTINGS_MORE_CALLBACK = "settings:more";
export const SETTINGS_EXTENSION_SELECT_PREFIX = "settings:extension:";
export const SETTINGS_EXTENSION_REMOVE_PREFIX = "settings:extension_remove:";
export const SETTINGS_ACTION_TOGGLE_PREFIX = "settings:action_toggle:";

function ref(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export async function buildGithubSettingsView(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const account = await getActiveGithubAccount();
  const identity = account?.username ? `@${account.username}` : account?.name;
  return {
    text: account
      ? `🐙 <b>GitHub</b>\n\nConnected as <b>${identity ?? "GitHub account"}</b>`
      : "🐙 <b>GitHub</b>\n\nNot connected",
    keyboard: new InlineKeyboard()
      .text(account ? "🔄 Reconnect" : "🔐 Connect", "integration:github:add")
      .row()
      .text("← Settings", "settings:back"),
  };
}

export async function buildExtensionsSettingsView(projectDirectory: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const extensions = await listExtensions(projectDirectory);
  const keyboard = new InlineKeyboard();
  for (const extension of extensions) {
    const icon = extension.kind === "mcp"
      ? "🔗"
      : extension.kind === "skill"
        ? "🧠"
        : extension.kind === "model-provider"
          ? "🤖"
          : extension.kind === "plugin"
            ? "🧩"
            : "🔌";
    keyboard.text(`${icon} ${extension.name} · ${extension.kind}`, SETTINGS_EXTENSION_SELECT_PREFIX + ref(extension.id)).row();
  }
  keyboard.text("← Settings", "settings:back");
  return {
    text: extensions.length
      ? "🧩 <b>Extensions</b>\n\nInstalled capabilities. Setup and re-authentication happen in chat with the model."
      : "🧩 <b>Extensions</b>\n\nNo Extensions installed yet. Ask the model to add what you need.",
    keyboard,
  };
}

export async function resolveExtensionRef(projectDirectory: string, shortRef: string): Promise<string | null> {
  const extensions = await listExtensions(projectDirectory);
  return extensions.find((extension) => ref(extension.id) === shortRef)?.id ?? null;
}

export async function buildExtensionDetailView(projectDirectory: string, id: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const extension = await getExtensionInfo(projectDirectory, id);
  if (!extension) {
    return { text: "Extension not found.", keyboard: new InlineKeyboard().text("← Extensions", SETTINGS_EXTENSIONS_CALLBACK) };
  }
  return {
    text: [
      `🧩 <b>${extension.name}</b>`,
      "",
      `Type · ${extension.kind}`,
      `Status · ${extension.status}`,
      `Auth · ${extension.authType}`,
      `Source · <code>${extension.source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code>`,
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text("🗑 Remove", SETTINGS_EXTENSION_REMOVE_PREFIX + ref(extension.id))
      .row()
      .text("← Extensions", SETTINGS_EXTENSIONS_CALLBACK),
  };
}

export async function buildActionsSettingsView(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const actions = await listGeneratedActions();
  const keyboard = new InlineKeyboard();
  let currentExtension = "";
  for (const action of actions) {
    if (action.extensionId !== currentExtension) {
      currentExtension = action.extensionId;
      keyboard.text(`— ${currentExtension} —`, "settings:actions").row();
    }
    keyboard
      .text(`${action.enabled ? "✅" : "⚪"} ${action.id}`, SETTINGS_ACTION_TOGGLE_PREFIX + ref(action.id))
      .row();
  }
  keyboard.text("← Settings", "settings:back");
  return {
    text: actions.length
      ? "⚡ <b>Actions</b>\n\nOnly model-generated Extension actions appear here. Tap an action to enable or disable it."
      : "⚡ <b>Actions</b>\n\nNo generated Extension actions yet.",
    keyboard,
  };
}

export async function resolveGeneratedActionRef(shortRef: string): Promise<string | null> {
  const actions = await listGeneratedActions();
  return actions.find((action) => ref(action.id) === shortRef)?.id ?? null;
}
