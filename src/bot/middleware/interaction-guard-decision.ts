import type { Context } from "grammy";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import type { BlockReason, ExpectedInput, GuardDecision, IncomingInputType, InteractionState, InteractionKind } from "../../app/types/interaction.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { attachManager } from "../../app/managers/attach-manager.js";
import { QUEUED_PROMPT_BUTTON_TEXT_PATTERN } from "../message-patterns.js";
import { isProviderWizardActive } from "../commands/providers-command.js";
import { isIntegrationWizardActive } from "../commands/integrations-command.js";

const BUSY_ALLOWED_COMMANDS = ["/abort", "/detach", "/status", "/help", "/opencode_stop"] as const;
const BUSY_ALLOWED_COMMAND_SET = new Set<string>(BUSY_ALLOWED_COMMANDS);
const BUSY_ALLOWED_CONTROL_TEXTS = new Set(["⏸️ Pause", "▶️ Resume", "🛑 Abort", "❌ Cancel"]);
const ROOT_NAVIGATION_TEXTS = new Set(["💬 New Chat", "📁 Projects", "⚙️ Settings"]);

function isBusyAllowedCommand(command?: string): boolean { return Boolean(command && BUSY_ALLOWED_COMMAND_SET.has(command)); }
function allowsBusyInteraction(kind: InteractionKind | undefined): boolean { return kind === "question" || kind === "permission"; }
function isQueuedPromptButtonPress(ctx: Context): boolean { const text = ctx.message?.text; return typeof text === "string" && QUEUED_PROMPT_BUTTON_TEXT_PATTERN.test(text); }
function isBusyControlButtonPress(ctx: Context): boolean { const text = ctx.message?.text?.trim(); return typeof text === "string" && BUSY_ALLOWED_CONTROL_TEXTS.has(text); }
function isSetupWizardText(ctx: Context): boolean { const chatId = ctx.chat?.id; return Boolean(chatId && ctx.message?.text && (isProviderWizardActive(chatId) || isIntegrationWizardActive(chatId))); }
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

export function resolveInteractionGuardDecision(ctx: Context): GuardDecision {
  const state = interactionManager.getSnapshot(); const { inputType, command } = classifyIncomingInput(ctx); const isBusy = foregroundSessionState.isBusy() || attachManager.isBusy();
  if (inputType === "text" && isSetupWizardText(ctx)) return createAllowDecision(inputType, state, command, isBusy);

  // Control buttons must remain actionable while an agent is busy. Pause/Resume/Abort/Cancel
  // are execution controls, not prompts, so they must reach the command/message router.
  if (isBusy && inputType === "text" && isBusyControlButtonPress(ctx)) {
    return createAllowDecision(inputType, state, command, true);
  }

  // A local inline menu is navigation state, not a blocking user interaction.
  // Root reply-keyboard navigation must be allowed to replace/close it.
  if (inputType === "text" && state?.kind === "inline" && isRootNavigationText(ctx)) {
    return createAllowDecision(inputType, state, command, isBusy);
  }

  if (state && interactionManager.isExpired()) { interactionManager.clear("expired"); return createBlockDecision(inputType, state, "expired", command, isBusy); }
  if (isBusy) {
    if (inputType === "command") { if (isBusyAllowedCommand(command)) return createAllowDecision(inputType, state, command, true); return createBusyBlockDecision(inputType, state, "command_not_allowed", command); }
    if (state && allowsBusyInteraction(state.kind)) {
      if (state.expectedInput === "mixed") { if (inputType === "callback" || inputType === "text") return createAllowDecision(inputType, state, command, true); return createBusyBlockDecision(inputType, state, "expected_text", command); }
      if (state.expectedInput === inputType) return createAllowDecision(inputType, state, command, true);
      return createBusyBlockDecision(inputType, state, getExpectedInputBlockReason(state.expectedInput), command);
    }
    if (inputType === "text" && isQueuedPromptButtonPress(ctx)) return createAllowDecision(inputType, state, command, true);
    return createBusyBlockDecision(inputType, state, "expected_text", command);
  }
  if (!state) return createAllowDecision(inputType, null, command);
  if (inputType === "command") { if (command === "/start") return createAllowDecision(inputType, state, command); if (command && state.allowedCommands.includes(command)) return createAllowDecision(inputType, state, command); return createBlockDecision(inputType, state, "command_not_allowed", command); }
  if (state.expectedInput === "mixed") { if (inputType === "callback" || inputType === "text") return createAllowDecision(inputType, state, command); return createBlockDecision(inputType, state, "expected_text", command); }
  if (inputType === "callback" && (isAllowedRenameCancelCallback(ctx, state) || isAllowedTaskCallback(ctx, state))) return createAllowDecision(inputType, state, command);
  if (state.expectedInput === inputType) return createAllowDecision(inputType, state, command);
  return createBlockDecision(inputType, state, getExpectedInputBlockReason(state.expectedInput), command);
}
