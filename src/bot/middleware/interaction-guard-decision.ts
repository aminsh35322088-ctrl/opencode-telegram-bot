import type { Context } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { questionManager } from "../../app/managers/question-manager.js";
import type { BlockReason, ExpectedInput, GuardDecision, IncomingInputType, InteractionState, InteractionKind } from "../../app/types/interaction.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { attachManager } from "../../app/managers/attach-manager.js";
import { QUEUED_PROMPT_BUTTON_TEXT_PATTERN, isReplyKeyboardButtonText } from "../message-patterns.js";
import { isProviderWizardActive } from "../commands/providers-command.js";
import { isIntegrationWizardActive } from "../commands/integrations-command.js";

const BUSY_ALLOWED_COMMANDS = ["/abort", "/detach", "/status", "/help", "/opencode_stop"] as const;
const BUSY_ALLOWED_COMMAND_SET = new Set<string>(BUSY_ALLOWED_COMMANDS);
const ROOT_NAVIGATION_TEXTS = new Set(["💬 New Chat", "📁 Projects", "⚙️ Settings"]);

function isBusyAllowedCommand(command?: string): boolean { return Boolean(command && BUSY_ALLOWED_COMMAND_SET.has(command)); }
function allowsBusyInteraction(kind: InteractionKind | undefined): boolean { return kind === "question" || kind === "permission"; }
function isQueuedPromptButtonPress(ctx: Context): boolean { const text = ctx.message?.text; return typeof text === "string" && QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text); }
function isReplyKeyboardPress(ctx: Context): boolean { const text = ctx.message?.text; return typeof text === "string" && isReplyKeyboardButtonText(text); }
function isSetupWizardText(ctx: Context): boolean { return Boolean(ctx.message?.text && (isProviderWizardActive() || isIntegrationWizardActive())); }
function isRootNavigationText(ctx: Context): boolean { const text = ctx.message?.text?.trim(); return typeof text === "string" && ROOT_NAVIGATION_TEXTS.has(text); }
function normalizeIncomingCommand(text: string): string | null { const trimmed = text.trim(); if (!trimmed.startsWith("/")) return null; const token = trimmed.split(/\s+/)[0]; if (!token) return null; const withoutMention = token.split("@")[0]?.toLowerCase(); return !withoutMention || withoutMention.length <= 1 ? null : withoutMention; }
function classifyIncomingInput(ctx: Context): { inputType: IncomingInputType; command?: string } {
  if (ctx.callbackQuery?.data) return { inputType: "callback" };
  const text = ctx.message?.text;
  if (typeof text === "string") { const command = normalizeIncomingCommand(text); return command ? { inputType: "command", command } : { inputType: "text" }; }
  return { inputType: "other" };
}
function getExpectedInputBlockReason(expectedInput: ExpectedInput): BlockReason { switch (expectedInput) { case "callback": return "expected_callback"; case "command": return "expected_command"; case "text": case "mixed": return "expected_text"; } }
function createAllowDecision(inputType: IncomingInputType, state: InteractionState | null, command?: string, busy?: boolean): GuardDecision { return { allow: true, inputType, state, command, busy }; }
function createBlockDecision(inputType: IncomingInputType, state: InteractionState, reason: BlockReason, command?: string, busy?: boolean): GuardDecision { return { allow: false, inputType, state, reason, command, busy }; }
function createBusyBlockDecision(inputType: IncomingInputType, state: InteractionState | null, reason: BlockReason, command?: string): GuardDecision { return { allow: false, inputType, state, reason, command, busy: true }; }
function isAllowedRenameCancelCallback(ctx: Context, state: InteractionState): boolean { return state.kind === "rename" && state.expectedInput === "text" && ctx.callbackQuery?.data === "rename:cancel"; }
function isAllowedTaskCallback(ctx: Context, state: InteractionState): boolean { return state.kind === "task" && (ctx.callbackQuery?.data === "task:cancel" || ctx.callbackQuery?.data === "task:retry-schedule"); }
function isStateForChat(state: InteractionState, chatId?: number): boolean {
  if (state.kind !== "inline") return true;
  const stateChatId = state.metadata.chatId;
  if (typeof stateChatId !== "number" || typeof chatId !== "number") return true;
  return stateChatId === chatId;
}

export function resolveInteractionGuardDecision(ctx: Context): GuardDecision {
  const rawState = interactionManager.getSnapshot();
  const state = rawState?.kind === "question" && !questionManager.isActiveForChat(ctx.chat?.id) ? null : rawState;
  const scopedState = state && isStateForChat(state, ctx.chat?.id) ? state : null;
  const { inputType, command } = classifyIncomingInput(ctx);
  if (inputType === "text" && isReplyKeyboardPress(ctx)) return createAllowDecision(inputType, scopedState, command, foregroundSessionState.isBusy() || attachManager.isBusy());
  const isBusy = foregroundSessionState.isBusy() || attachManager.isBusy();
  if (inputType === "text" && isSetupWizardText(ctx)) return createAllowDecision(inputType, scopedState, command, isBusy);
  if (isBusy && inputType === "text" && isQueuedPromptButtonPress(ctx)) return createAllowDecision(inputType, scopedState, command, true);
  if (inputType === "text" && scopedState?.kind === "inline" && isRootNavigationText(ctx)) return createAllowDecision(inputType, scopedState, command, isBusy);
  if (scopedState && interactionManager.isExpired()) { interactionManager.clear("expired"); return createBlockDecision(inputType, scopedState, "expired", command, isBusy); }
  if (isBusy) {
    if (inputType === "command") { if (isBusyAllowedCommand(command)) return createAllowDecision(inputType, scopedState, command, true); return createBusyBlockDecision(inputType, scopedState, "command_not_allowed", command); }
    if (scopedState && allowsBusyInteraction(scopedState.kind)) {
      if (scopedState.expectedInput === "mixed") { if (inputType === "callback" || inputType === "text") return createAllowDecision(inputType, scopedState, command, true); return createBusyBlockDecision(inputType, scopedState, "expected_text", command); }
      if (scopedState.expectedInput === inputType) return createAllowDecision(inputType, scopedState, command, true);
      return createBusyBlockDecision(inputType, scopedState, getExpectedInputBlockReason(scopedState.expectedInput), command);
    }
    return createBusyBlockDecision(inputType, scopedState, "expected_text", command);
  }
  if (!scopedState) return createAllowDecision(inputType, null, command);
  if (inputType === "command") { if (command === "/start") return createAllowDecision(inputType, scopedState, command); if (command && scopedState.allowedCommands.includes(command)) return createAllowDecision(inputType, scopedState, command); return createBlockDecision(inputType, scopedState, "command_not_allowed", command); }
  if (scopedState.expectedInput === "mixed") { if (inputType === "callback" || inputType === "text") return createAllowDecision(inputType, scopedState, command); return createBlockDecision(inputType, scopedState, "expected_text", command); }
  if (inputType === "callback" && (isAllowedRenameCancelCallback(ctx, scopedState) || isAllowedTaskCallback(ctx, scopedState))) return createAllowDecision(inputType, scopedState, command);
  if (scopedState.expectedInput === inputType) return createAllowDecision(inputType, scopedState, command);
  return createBlockDecision(inputType, scopedState, getExpectedInputBlockReason(scopedState.expectedInput), command);
}
