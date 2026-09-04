import type { Context, NextFunction } from "grammy";
import { resolveInteractionGuardDecision } from "./interaction-guard-decision.js";
import type { BlockReason, InteractionKind } from "../../app/types/interaction.js";
import { reconcileForegroundBusyState } from "../../app/services/run-control-service.js";
import {
  shouldSuggestPromptQueue,
  tryEnqueuePrompt,
} from "../handlers/prompt-queue-dispatch.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { isImageAiOperationActive } from "../../app/services/image-mode-service.js";
import { isReplyKeyboardButtonText } from "../message-patterns.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatModelForButton } from "../../app/types/model.js";

function getInteractionBlockedMessage(
  reason: BlockReason | undefined,
  interactionKind: InteractionKind | undefined,
): string {
  if (interactionKind === "permission") {
    switch (reason) {
      case "command_not_allowed":
        return t("permission.blocked.command_not_allowed");
      case "expected_callback":
      case "expected_command":
      case "expected_text":
      default:
        return t("permission.blocked.expected_reply");
    }
  }

  if (interactionKind === "inline") {
    switch (reason) {
      case "command_not_allowed":
        return t("inline.blocked.command_not_allowed");
      case "expected_callback":
      case "expected_command":
      case "expected_text":
      default:
        return t("inline.blocked.expected_choice");
    }
  }

  if (interactionKind === "question") {
    switch (reason) {
      case "command_not_allowed":
        return t("question.blocked.command_not_allowed");
      case "expected_callback":
      case "expected_command":
      case "expected_text":
      default:
        return t("question.blocked.expected_answer");
    }
  }

  if (interactionKind === "rename") {
    switch (reason) {
      case "command_not_allowed":
        return t("rename.blocked.command_not_allowed");
      case "expected_callback":
      case "expected_command":
      case "expected_text":
      default:
        return t("rename.blocked.expected_name");
    }
  }

  if (interactionKind === "task") {
    switch (reason) {
      case "command_not_allowed":
        return t("task.blocked.command_not_allowed");
      case "expected_callback":
      case "expected_command":
      case "expected_text":
      default:
        return t("task.blocked.expected_input");
    }
  }

  switch (reason) {
    case "expired":
      return t("interaction.blocked.expired");
    case "expected_callback":
      return t("interaction.blocked.expected_callback");
    case "expected_command":
      return t("interaction.blocked.expected_command");
    case "command_not_allowed":
      return t("interaction.blocked.command_not_allowed");
    case "expected_text":
    default:
      return t("interaction.blocked.expected_text");
  }
}

function isImageOperationControl(ctx: Context): boolean {
  const text = ctx.message?.text;
  if (typeof text !== "string") return false;
  const model = getStoredModel();
  const knownButtonTexts = new Set<string>();
  if (model.providerID && model.modelID) {
    knownButtonTexts.add(formatModelForButton(model.providerID, model.modelID, model.name));
  }
  return isReplyKeyboardButtonText(text, knownButtonTexts);
}

export async function interactionGuardMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  // Image AI owns the session until its result is delivered. Do not let
  // ordinary text/voice-driven prompt paths enter Coding AI while the image
  // provider is still working. Reply-keyboard controls remain available.
  if (ctx.message?.text && isImageAiOperationActive() && !isImageOperationControl(ctx)) {
    await ctx.reply("⏳ Image AI is still working on the current request. Please wait for the image to be delivered.").catch(() => {});
    return;
  }

  let decision = resolveInteractionGuardDecision(ctx);

  if (!decision.allow && decision.busy) {
    await reconcileForegroundBusyState();
    decision = resolveInteractionGuardDecision(ctx);
  }

  if (decision.allow) {
    await next();
    return;
  }

  const queueableText = ctx.message?.text;
  const isQueueableInput = Boolean(
    decision.busy && decision.inputType === "text" && !decision.state && queueableText,
  );

  if (isQueueableInput) {
    const queued = await tryEnqueuePrompt(ctx, queueableText!);
    if (queued) {
      return;
    }
  }

  let message = decision.busy
    ? decision.state?.kind === "question" || decision.state?.kind === "permission"
      ? getInteractionBlockedMessage(decision.reason, decision.state.kind)
      : t("bot.session_busy")
    : getInteractionBlockedMessage(decision.reason, decision.state?.kind);

  // Only hint where the message would actually have been queued - not for button
  // presses or commands that are turned down while the agent is busy.
  if (isQueueableInput && shouldSuggestPromptQueue(queueableText!)) {
    message = `${message} ${t("queue.disabled_hint")}`;
  }

  logger.debug(
    `[InteractionGuard] Blocked input: interactionKind=${decision.state?.kind || "none"}, inputType=${decision.inputType}, reason=${decision.reason || "unknown"}, command=${decision.command || "-"}, busy=${decision.busy ? "yes" : "no"}`,
  );

  if (ctx.callbackQuery) {
    // A callback can outlive the interaction that created its inline keyboard.
    // Never surface a text-oriented choice prompt for such a stale button press.
    await ctx.answerCallbackQuery({
      text: t("inline.inactive_callback"),
      show_alert: false,
    }).catch(() => {});
    return;
  }

  if (ctx.chat) {
    await ctx.reply(message).catch((err) => {
      logger.error("[InteractionGuard] Failed to send blocked input message:", err);
    });
  }
}
