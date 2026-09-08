import type { Context } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import { questionManager } from "../../app/managers/question-manager.js";
import type { BlockReason, ExpectedInput, GuardDecision, IncomingInputType, InteractionState, InteractionKind } from "../../app/types/interaction.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { attachManager } from "../../app/managers/attach-manager.js";
import { QUEUED_PROMPT_BUTTON_TEXT_PATTERN, isReplyKeyboardButtonText } from "../message-patterns.js";
import { isProviderWizardActive } from "../commands/providers-command.js";
import { isIntegrationWizardActive } from "../commands/integrations-command.js";
import { isMcpAddWizardActive } from "../commands/mcp-catalog-command.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatModelForButton } from "../../app/types/model.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { getCurrentSession } from "../../app/services/session-service.js";

// Commands that manage an existing run must always reach their handler, even
// while the session is busy or an interaction is pending. The equivalent
// Reply Keyboard buttons are consumed by the router before this guard runs, so
// slash-command parity requires the same commands to pass through here. Menu
// controls (model/agent/variant/context/compact/topic_settings) intentionally
// stay gated while busy, matching the buttons' menuAllowed behavior.
const ALWAYS_REACHABLE_CONTROL_COMMANDS = new Set<string>([
  "/abort",
  "/stop",
  "/detach",
  "/status",
  "/help",
  "/opencode_stop",
  "/pause",
  "/resume",
  "/delete_topic",
]);
function isBusyAllowedCommand(command?: string): boolean { return Boolean(command && ALWAYS_REACHABLE_CONTROL_COMMANDS.has(command)); }
const ROOT_NAVIGATION_TEXTS = new Set(["💬 New Chat", "📁 Projects", "⚙️ Settings"]);
function allowsBusyInteraction(kind: InteractionKind | undefined): boolean { return kind === "question" || kind === "permission"; }
function isQueuedPromptButtonPress(ctx: Context): boolean { const text = ctx.message?.text; return typeof text === "string" && QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text); }
function resolveCurrentSessionBusy(): boolean {
  const topic = getTopicRuntimeContext();
  const sessionId = topic?.sessionId ?? getCurrentSession()?.id;
  if (!sessionId) return foregroundSessionState.isBusy();
  return foregroundSessionState.isSessionBusy(sessionId) || attachManager.isBusy();
}
function isReplyKeyboardPress(ctx: Context): boolean {
  const text = ctx.message?.text;
  if (typeof text !== "string") return false;
  const model = getStoredModel();
  const knownButtonTexts = new Set<string>();
  if (model.providerID && model.modelID) knownButtonTexts.add(formatModelForButton(model.providerID, model.modelID, model.name));
  return isReplyKeyboardButtonText(text, knownButtonTexts);
}
function isSetupWizardText(ctx: Context): boolean { return Boolean(ctx.message?.text && (isProviderWizardActive() || isIntegrationWizardActive() || isMcpAddWizardActive())); }
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
  const isBusy = resolveCurrentSessionBusy();
  if (inputType === "text" && isReplyKeyboardPress(ctx)) return createAllowDecision(inputType, scopedState, command, isBusy);
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
  if (inputType === "command") { if (command === "/start") return createAllowDecision(inputType, scopedState, command); if (isBusyAllowedCommand(command)) return createAllowDecision(inputType, scopedState, command); if (command && scopedState.allowedCommands.includes(command)) return createAllowDecision(inputType, scopedState, command); return createBlockDecision(inputType, scopedState, "command_not_allowed", command); }
  if (scopedState.expectedInput === "mixed") { if (inputType === "callback" || inputType === "text") return createAllowDecision(inputType, scopedState, command); return createBlockDecision(inputType, scopedState, "expected_text", command); }
  if (inputType === "callback" && (isAllowedRenameCancelCallback(ctx, scopedState) || isAllowedTaskCallback(ctx, scopedState))) return createAllowDecision(inputType, scopedState, command);
  if (scopedState.expectedInput === inputType) return createAllowDecision(inputType, scopedState, command);
  return createBlockDecision(inputType, scopedState, getExpectedInputBlockReason(scopedState.expectedInput), command);
}
