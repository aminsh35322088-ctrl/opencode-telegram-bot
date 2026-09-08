import { Context, InlineKeyboard } from "grammy";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import {
  formatVariantForDisplay,
  getAvailableVariants,
  getCurrentVariant,
} from "../../app/services/variant-selection-service.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { replyWithInlineMenu } from "./inline-menu.js";

/** Build the active variant choices for the current Topic/model. */
export async function buildVariantSelectionMenu(currentVariant: string, providerID: string, modelID: string): Promise<InlineKeyboard> {
  const keyboard = new InlineKeyboard();
  const variants = await getAvailableVariants(providerID, modelID);

  if (variants.length === 0) {
    logger.warn("[VariantHandler] No variants found");
    return keyboard;
  }

  const activeVariants = variants.filter((variant) => !variant.disabled);
  if (activeVariants.length === 0) {
    logger.warn("[VariantHandler] No active variants found");
    keyboard.text(`✅ ${formatVariantForDisplay("default")}`, "variant:default").row();
    return keyboard;
  }

  for (const variant of activeVariants) {
    const label = formatVariantForDisplay(variant.id);
    keyboard.text(variant.id === currentVariant ? `✅ ${label}` : label, `variant:${variant.id}`).row();
  }

  return keyboard;
}

function isTopicContext(ctx: Context): boolean {
  const message = ctx.message ?? ctx.callbackQuery?.message;
  const threadId = message && "message_thread_id" in message ? (message as { message_thread_id?: number }).message_thread_id : undefined;
  return typeof threadId === "number" && threadId > 1;
}

/** Show model-specific variants. Selecting one updates only the current Topic when opened from a Topic. */
export async function showVariantSelectionMenu(ctx: Context): Promise<void> {
  try {
    const currentModel = getStoredModel();
    if (!currentModel.providerID || !currentModel.modelID) {
      await ctx.reply(t("variant.select_model_first"));
      return;
    }

    const currentVariant = getCurrentVariant();
    const keyboard = await buildVariantSelectionMenu(currentVariant, currentModel.providerID, currentModel.modelID);
    if (keyboard.inline_keyboard.length === 0) {
      await ctx.reply(t("variant.menu.empty"));
      return;
    }

    const text = [
      "🎛 <b>Variant</b>",
      "",
      `Current: <b>${formatVariantForDisplay(currentVariant)}</b>`,
      "",
      "Variants change model-specific behavior such as reasoning depth or response strategy when the selected model exposes them.",
      "Choose one below. The selection is scoped to the current Topic when this menu is opened from Topic Settings.",
    ].join("\n");

    await replyWithInlineMenu(ctx, {
      menuKind: "variant",
      text,
      keyboard,
      parseMode: "HTML",
      navigation: isTopicContext(ctx) ? "both" : "auto",
    });
  } catch (err) {
    logger.error("[VariantHandler] Error showing variant menu:", err);
    await ctx.reply(t("variant.menu.error"));
  }
}
