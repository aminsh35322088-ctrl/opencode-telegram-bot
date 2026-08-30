import type { Context } from "grammy";
import { questionManager } from "../../app/managers/question-manager.js";
import {
  clearQuestionInteraction,
  showNextQuestion,
  syncQuestionInteractionState,
  updateQuestionMessage,
} from "../menus/question-menu.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { alert, cancelPrompt } from "./feedback.js";

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

export async function handleQuestionCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith("question:")) return false;
  logger.debug(`[QuestionHandler] Received callback: ${data}`);

  const chatId = ctx.chat?.id;
  if (!questionManager.isActiveForChat(chatId)) {
    // A question belongs to the Telegram chat that owns its UI. Do not let a
    // stale/global question state consume callbacks from another chat.
    await ctx.answerCallbackQuery({ text: t("question.inactive_callback"), show_alert: true });
    return true;
  }

  const callbackMessageId = getCallbackMessageId(ctx);
  if (!questionManager.isActiveMessage(callbackMessageId)) {
    await ctx.answerCallbackQuery({ text: t("question.inactive_callback"), show_alert: true });
    return true;
  }

  const parts = data.split(":");
  const action = parts[1];
  const questionIndex = parseInt(parts[2] ?? "", 10);
  if (Number.isNaN(questionIndex) || questionIndex !== questionManager.getCurrentIndex()) {
    await ctx.answerCallbackQuery({ text: t("question.inactive_callback"), show_alert: true });
    return true;
  }

  try {
    switch (action) {
      case "select": {
        const optionIndex = parseInt(parts[3] ?? "", 10);
        if (Number.isNaN(optionIndex)) {
          await ctx.answerCallbackQuery({ text: t("question.processing_error_callback"), show_alert: true });
          break;
        }
        await handleSelectOption(ctx, questionIndex, optionIndex);
        break;
      }
      case "submit": await handleSubmitAnswer(ctx, questionIndex); break;
      case "custom": await handleCustomAnswer(ctx, questionIndex); break;
      case "cancel": await handleCancelPoll(ctx); break;
      default: await ctx.answerCallbackQuery({ text: t("question.processing_error_callback"), show_alert: true }); break;
    }
  } catch (err) {
    logger.error("[QuestionHandler] Error handling callback:", err);
    await ctx.answerCallbackQuery({ text: t("question.processing_error_callback"), show_alert: true });
  }
  return true;
}

async function handleSelectOption(ctx: Context, questionIndex: number, optionIndex: number): Promise<void> {
  const question = questionManager.getCurrentQuestion();
  if (!question) { await alert(ctx, "question.inactive_callback"); return; }
  if (questionManager.isWaitingForCustomInput(questionIndex)) {
    questionManager.clearCustomInput();
    syncQuestionInteractionState("callback", questionIndex, questionManager.getActiveMessageId());
  }
  questionManager.selectOption(questionIndex, optionIndex);
  if (question.multiple) {
    await updateQuestionMessage(ctx);
    await ctx.answerCallbackQuery();
  } else {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    await showNextQuestion(ctx);
  }
}

async function handleSubmitAnswer(ctx: Context, questionIndex: number): Promise<void> {
  if (questionManager.isWaitingForCustomInput(questionIndex)) {
    questionManager.clearCustomInput();
    syncQuestionInteractionState("callback", questionIndex, questionManager.getActiveMessageId());
  }
  const answer = questionManager.getSelectedAnswer(questionIndex);
  if (!answer) {
    await ctx.answerCallbackQuery({ text: t("question.select_one_required_callback"), show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await showNextQuestion(ctx);
}

async function handleCustomAnswer(ctx: Context, questionIndex: number): Promise<void> {
  questionManager.startCustomInput(questionIndex);
  syncQuestionInteractionState("mixed", questionIndex, questionManager.getActiveMessageId());
  await ctx.answerCallbackQuery({ text: t("question.enter_custom_callback"), show_alert: true });
}

async function handleCancelPoll(ctx: Context): Promise<void> {
  questionManager.cancel();
  clearQuestionInteraction("question_cancelled");
  await cancelPrompt(ctx, "question.cancelled");
  questionManager.clear();
}

export async function handleQuestionTextAnswer(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text || !questionManager.isActiveForChat(ctx.chat?.id)) return;

  const currentIndex = questionManager.getCurrentIndex();
  if (!questionManager.isWaitingForCustomInput(currentIndex)) {
    await ctx.reply(t("question.use_custom_button_first"));
    return;
  }
  if (questionManager.hasCustomAnswer(currentIndex)) {
    await ctx.reply(t("question.answer_already_received"));
    return;
  }

  logger.debug(`[QuestionHandler] Custom text answer for question ${currentIndex}: ${text}`);
  questionManager.setCustomAnswer(currentIndex, text);
  questionManager.clearCustomInput();
  const activeMessageId = questionManager.getActiveMessageId();
  if (activeMessageId !== null && ctx.chat) await ctx.api.deleteMessage(ctx.chat.id, activeMessageId).catch(() => {});
  await showNextQuestion(ctx);
}
