import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Context } from "grammy";
import {
  catalogEntryMatchesSelection,
  imageCatalogSelection,
  listImageModelCatalog,
  type ImageModelCatalogEntry,
} from "../../app/services/image-model-catalog-service.js";
import {
  getCurrentTopicImageModelOverride,
  getCurrentTopicSettings,
  getDefaultImageModel,
  setCurrentTopicImageModelOverride,
  setDefaultImageModel,
} from "../../app/stores/settings-store.js";
import type { ImageModelSelection } from "../../app/types/image-model.js";
import {
  SETTINGS_BACK_CALLBACK,
  SETTINGS_DEFAULT_MODELS_CALLBACK,
  SETTINGS_IMAGE_MODEL_CALLBACK,
} from "./settings-menu.js";

const PICK_PREFIX = SETTINGS_IMAGE_MODEL_CALLBACK + ":pick:";
const RESET_CALLBACK = SETTINGS_IMAGE_MODEL_CALLBACK + ":reset";
const MANAGE_CONNECTIONS_CALLBACK = "provider:image:engines";
const CHOICE_TTL_MS = 15 * 60_000;
const MAX_CHOICES = 200;

interface ImageModelChoice {
  scope: string;
  selection: ImageModelSelection;
  expiresAt: number;
}

const choices = new Map<string, ImageModelChoice>();

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function scope(ctx: Context): string {
  const message = ctx.callbackQuery?.message ?? ctx.message;
  const threadID = message && "message_thread_id" in message
    ? message.message_thread_id ?? 0
    : 0;
  return String(ctx.chat?.id ?? "unknown") + ":" + String(threadID > 1 ? threadID : 0);
}

function formatSelection(
  selection: ImageModelSelection | undefined,
  catalog: ImageModelCatalogEntry[],
): string {
  if (!selection) return "Not configured";
  const entry = catalog.find((candidate) =>
    catalogEntryMatchesSelection(candidate, selection));
  if (!entry) {
    return html(selection.providerID) + " · " + html(selection.modelID) + " · unavailable";
  }
  return html(entry.providerName) + " · " + html(entry.modelName);
}

function choice(ctx: Context, selection: ImageModelSelection): string {
  const token = randomBytes(8).toString("hex");
  choices.set(token, {
    scope: scope(ctx),
    selection,
    expiresAt: Date.now() + CHOICE_TTL_MS,
  });
  while (choices.size > MAX_CHOICES) choices.delete(choices.keys().next().value!);
  return PICK_PREFIX + token;
}

export async function buildImageModelSettingsView(
  ctx: Context,
  notice = "",
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const catalog = (await listImageModelCatalog())
    .filter((entry) =>
      entry.capabilities.includes("generate")
      && entry.capabilities.includes("edit"));
  const topic = getCurrentTopicSettings();
  const globalDefault = getDefaultImageModel();
  const override = getCurrentTopicImageModelOverride();
  const current = override ?? globalDefault;
  const source = topic ? (override ? "Topic Override" : "Main Default") : "Main Default";

  const keyboard = new InlineKeyboard();
  if (topic && override) keyboard.text("↩️ Use Main Default", RESET_CALLBACK).row();

  for (const entry of catalog.slice(0, 60)) {
    const selection = imageCatalogSelection(entry);
    const activeSelection = topic ? override : globalDefault;
    const selected = activeSelection
      ? catalogEntryMatchesSelection(entry, activeSelection)
      : false;
    keyboard.text(
      (selected ? "✅ " : "🎨 ") + entry.providerName + " · " + entry.modelName,
      choice(ctx, selection),
    ).row();
  }

  keyboard.text("🔌 Manage image connections", MANAGE_CONNECTIONS_CALLBACK).row();
  keyboard.text(
    topic ? "← Topic Settings" : "← Default Models",
    topic ? SETTINGS_BACK_CALLBACK : SETTINGS_DEFAULT_MODELS_CALLBACK,
  );

  const lines = [
    notice,
    "🎨 <b>Image Model</b>",
    "",
    "Source · " + source,
    "Current · " + formatSelection(current, catalog),
    "",
    topic
      ? "Choose an override for this AI Topic, or inherit the Main Default."
      : "Choose the default generator/editor inherited by AI Topics without an override.",
    "",
    "There is no automatic fallback. If the selected image model becomes unavailable, image actions fail explicitly until you choose another model.",
  ];
  if (catalog.length === 0) {
    lines.push("", "No configured image connection currently supports both generation and editing.");
  }

  return { text: lines.filter(Boolean).join("\n"), keyboard };
}

export async function handleImageModelSettingsCallback(
  ctx: Context,
  data: string,
): Promise<boolean> {
  if (data === SETTINGS_IMAGE_MODEL_CALLBACK) {
    await ctx.answerCallbackQuery().catch(() => {});
    const view = await buildImageModelSettingsView(ctx);
    await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
    return true;
  }

  if (data === RESET_CALLBACK) {
    if (!getCurrentTopicSettings()) {
      await ctx.answerCallbackQuery({
        text: "Image Model reset is Topic-only.",
        show_alert: true,
      });
      return true;
    }
    setCurrentTopicImageModelOverride(undefined);
    await ctx.answerCallbackQuery({ text: "Using Main Default" }).catch(() => {});
    const view = await buildImageModelSettingsView(
      ctx,
      "✅ Topic now inherits the Main Default.\n",
    );
    await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
    return true;
  }

  if (!data.startsWith(PICK_PREFIX)) return false;

  const token = data.slice(PICK_PREFIX.length);
  const selected = choices.get(token);
  choices.delete(token);
  if (!selected || selected.scope !== scope(ctx) || selected.expiresAt < Date.now()) {
    await ctx.answerCallbackQuery({
      text: "This Image Model selection expired. Reopen the menu.",
      show_alert: true,
    });
    return true;
  }

  const catalog = await listImageModelCatalog();
  const model = catalog.find((candidate) =>
    catalogEntryMatchesSelection(candidate, selected.selection));
  if (!model) {
    await ctx.answerCallbackQuery({
      text: "This Image Model is no longer available. Reopen the menu.",
      show_alert: true,
    });
    return true;
  }

  if (getCurrentTopicSettings()) setCurrentTopicImageModelOverride(selected.selection);
  else setDefaultImageModel(selected.selection);

  await ctx.answerCallbackQuery({ text: "Image Model saved" }).catch(() => {});
  const view = await buildImageModelSettingsView(ctx, "✅ Image Model saved.\n");
  await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
  return true;
}

export function clearImageModelMenuChoices(): void {
  choices.clear();
}