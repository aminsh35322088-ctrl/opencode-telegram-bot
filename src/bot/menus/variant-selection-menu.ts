import { Context, InlineKeyboard } from "grammy";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import {
  formatVariantForDisplay,
  getCurrentVariant,
  getVariantAvailability,
} from "../../app/services/variant-selection-service.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { replyWithInlineMenu } from "./inline-menu.js";

/** Build active variant choices for the selected model from OpenCode metadata. */
export async function buildVariantSelectionMenu(
  currentVariant: string,
  providerID: string,
  modelID: string,
): Promise<InlineKeyboard> {
  const keyboard = new InlineKeyboard();
  const availability = await getVariantAvailability(providerID, modelID);

  if (!availability.supported) {
    return keyboard;
  }

  for (const variant of availability.variants.filter((item) => !item.disabled)) {
    const label = formatVariantForDisplay(variant.id);
    keyboard
      .text(variant.id === currentVariant ? `✅ ${label}` : label, `variant:${variant.id}`)
      .row();
  }

  return keyboard;
}

function isTopicContext(ctx: Context): boolean {
  const message = ctx.message ?? ctx.callbackQuery?.message;
  const threadId =
    message && "message_thread_id" in message
      ? (message as { message_thread_id?: number }).message_thread_id
      : undefined;
  return typeof threadId === "number" && threadId > 1;
}

function availabilityMessage(
  reason: "UNSUPPORTED" | "PROVIDER_NOT_FOUND" | "MODEL_NOT_FOUND" | "UNAVAILABLE",
): string {
  switch (reason) {
    case "UNSUPPORTED":
      return "⚪ <b>Unsupported</b>\nThis model does not expose any variants through OpenCode.";
    case "UNAVAILABLE":
      return "🟡 <b>Unavailable</b>\nOpenCode variant metadata could not be loaded right now. No variant was changed.";
    case "PROVIDER_NOT_FOUND":
      return "🟡 <b>Unavailable</b>\nThe selected provider is not available in OpenCode right now.";
    case "MODEL_NOT_FOUND":
      return "🟡 <b>Unavailable</b>\nThe selected model is not available in OpenCode right now.";
  }
}

/** Show model-specific variants without inventing defaults. */
export async function showVariantSelectionMenu(ctx: Context): Promise<void> {
  try {
    const currentModel = getStoredModel();
    if (!currentModel.providerID || !currentModel.modelID) {
      await ctx.reply(t("variant.select_model_first"));
      return;
    }

    const currentVariant = getCurrentVariant();
    const availability = await getVariantAvailability(
      currentModel.providerID,
      currentModel.modelID,
    );
    const keyboard = availability.supported
      ? await buildVariantSelectionMenu(
          currentVariant,
          currentModel.providerID,
          currentModel.modelID,
        )
      : new InlineKeyboard();

    const currentLabel = availability.supported
      ? availability.variants.some((variant) => variant.id === currentVariant && !variant.disabled)
        ? formatVariantForDisplay(currentVariant)
        : "Auto"
      : availability.reason === "UNSUPPORTED"
        ? "Unsupported"
        : "Unavailable";

    const lines = [
      "🎛 <b>Variant</b>",
      "",
      `Model: <b>${currentModel.modelID}</b>`,
      `Current: <b>${currentLabel}</b>`,
      "",
      availability.supported
        ? "Variants are model-specific OpenCode execution presets. Only variants actually exposed by the selected model are shown."
        : availabilityMessage(availability.reason),
    ];

    if (availability.supported && keyboard.inline_keyboard.length === 0) {
      lines.push("", "⚪ <b>No enabled variants</b>", "All variants exposed by this model are disabled.");
    }

    await replyWithInlineMenu(ctx, {
      menuKind: "variant",
      text: lines.join("\n"),
      keyboard,
      parseMode: "HTML",
      navigation: isTopicContext(ctx) ? "both" : "auto",
    });
  } catch (err) {
    logger.error("[VariantHandler] Error showing variant menu:", err);
    await ctx.reply(t("variant.menu.error"));
  }
}
