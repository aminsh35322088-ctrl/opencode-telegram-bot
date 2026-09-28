import type { Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getEffectiveCurrentSession } from "../../app/services/session-service.js";
import { abortCurrentOperation, type AbortResult } from "./abort-command.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import {
  clearPausedSession,
  getPausedSession,
  getPausedSubagents,
  isChatPaused,
  setPausedSession,
  setPausedSubagents,
  type PausedSubagentRef,
} from "../../app/managers/paused-session-manager.js";
import { processUserPrompt, type ProcessPromptDeps } from "../handlers/prompt.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatModelForDisplay } from "../../app/types/model.js";
import { logger } from "../../utils/logger.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { summaryAggregator } from "../../app/managers/summary-aggregation-manager.js";
import { updateTopicRuntimeStateSync } from "../../app/stores/topic-runtime-state-store.js";
import { subagentTopicInspector } from "../services/subagent-topic-inspector.js";

const RESUME_PROMPT =
  "[resume] Continue the interrupted task from the current session state. Preserve completed work, inspect the current state, and continue only what remains. Do not restart completed work.";

function isActiveStatus(type: string | undefined): boolean {
  return type === "busy" || type === "retry";
}

async function hasActiveRemoteTool(sessionId: string, directory: string): Promise<boolean> {
  try {
    const { data: messages, error } = await opencodeClient.session.messages({
      sessionID: sessionId,
      directory,
      limit: 10,
    });
    if (error || !messages) return false;
    return messages.some((message) =>
      (
        message.parts as Array<{
          type?: string;
          state?: { status?: string };
        }>
      ).some(
        (part) =>
          part.type === "tool" &&
          (part.state?.status === "running" || part.state?.status === "pending"),
      ),
    );
  } catch (error) {
    logger.debug("[Pause] Failed to inspect recent tool parts:", error);
    return false;
  }
}

function describeAbortResult(result: AbortResult): string {
  switch (result) {
    case "confirmed":
      return "⏸️ Pause confirmed.";
    case "timeout":
      return "⚠️ OpenCode did not confirm the stop before the timeout. The chat was not marked paused.";
    case "unconfirmed":
      return "⚠️ OpenCode did not confirm a safe stop. The chat was not marked paused.";
    case "maybe-finished":
      return "ℹ️ The run appears to have finished before the stop completed.";
    case "no-session":
      return "ℹ️ There is no active chat to pause.";
    default:
      return "⚠️ Pause failed. The chat was not marked paused.";
  }
}

function buildResumePrompt(subagents: PausedSubagentRef[], userPrompt?: string): string {
  const continuation = userPrompt?.trim() || RESUME_PROMPT;
  if (subagents.length === 0) return continuation;

  const taskIds = subagents
    .map((subagent) => {
      const context = [subagent.agent, subagent.title].filter(Boolean).join(" · ");
      return `- task_id=${subagent.sessionId}${context ? ` (${context})` : ""}`;
    })
    .join("\n");

  return [
    continuation,
    "",
    "[subagent-resume-contract]",
    "The parent chat was paused, not intentionally aborted. Its unfinished delegated child sessions must retain identity.",
    "Resume each relevant delegated task through the task tool using the exact existing task_id below. Do not create a replacement sub-agent for the same work unless that exact child session is unavailable.",
    taskIds,
    "[/subagent-resume-contract]",
  ].join("\n");
}

async function captureActiveSubagents(
  parentSessionId: string,
  directory: string,
  statuses?: Record<string, { type?: string }>,
): Promise<PausedSubagentRef[]> {
  const refs = new Map<string, PausedSubagentRef>();

  for (const subagent of summaryAggregator.getSubagentsForParent(parentSessionId)) {
    if (!subagent.sessionId) continue;
    if (
      subagent.status !== "running" &&
      subagent.status !== "pending" &&
      subagent.status !== "paused"
    ) {
      continue;
    }
    refs.set(subagent.sessionId, {
      sessionId: subagent.sessionId,
      agent: subagent.agent || undefined,
      title: subagent.description || undefined,
    });
  }

  try {
    const { data: children, error } = await opencodeClient.session.children({
      sessionID: parentSessionId,
      directory,
    });
    if (!error && children) {
      for (const child of children) {
        const status = statuses?.[child.id]?.type;
        const known = refs.get(child.id);
        if (!known && !isActiveStatus(status)) continue;
        refs.set(child.id, {
          sessionId: child.id,
          agent: known?.agent ?? child.agent ?? undefined,
          title: known?.title ?? child.title ?? undefined,
        });
      }
    }
  } catch (error) {
    logger.debug("[Pause] Failed to enumerate child sessions before pause:", error);
  }

  return Array.from(refs.values());
}

export async function pauseCurrentChat(ctx: Context): Promise<void> {
  const session = await getEffectiveCurrentSession();
  if (!session) {
    await ctx.reply("ℹ️ There is no active chat to pause. Tap 💬 New Chat to start one.");
    return;
  }
  if (isChatPaused(session.id)) {
    await ctx.reply("⏸️ This chat is already paused.");
    return;
  }

  let pauseStateArmed = false;
  let pauseConfirmed = false;
  try {
    const { data, error } = await opencodeClient.session.status({
      directory: session.directory,
    });
    const statuses = data as Record<string, { type?: string }> | undefined;
    const state = statuses?.[session.id];
    const localRunActive = assistantRunState.hasActiveRun(session.id);
    const foregroundActive = foregroundSessionState
      .getBusySessions()
      .some((busySession) => busySession.sessionId === session.id);
    const remoteToolActive = await hasActiveRemoteTool(session.id, session.directory);

    logger.info(
      `[Pause] Button invoked: session=${session.id}, status=${state?.type ?? "missing"}, statusError=${error ? "yes" : "no"}, localRunActive=${localRunActive}, foregroundActive=${foregroundActive}, remoteToolActive=${remoteToolActive}`,
    );

    if (error && !localRunActive && !foregroundActive && !remoteToolActive) throw error;
    if (
      !isActiveStatus(state?.type) &&
      !localRunActive &&
      !foregroundActive &&
      !remoteToolActive
    ) {
      await ctx.reply("ℹ️ Nothing is running right now, so there is nothing to pause.");
      return;
    }

    const pausedSubagents = await captureActiveSubagents(
      session.id,
      session.directory,
      statuses,
    );

    // OpenCode exposes abort rather than a native execution suspend. Mark the
    // parent paused before interrupting so child terminal events are interpreted
    // as resumable, then preserve exact task_id values for the next generation.
    setPausedSession(session);
    setPausedSubagents(session.id, pausedSubagents);
    keyboardManager.setPaused(true, session.id);
    pauseStateArmed = true;

    await subagentTopicInspector.pauseForParent(ctx.api, session.id).catch((error) =>
      logger.warn(
        `[Pause] Failed to pause sub-agent inspector UI: session=${session.id}`,
        error,
      ),
    );

    const abortResult = await abortCurrentOperation(ctx, {
      notifyUser: false,
      restoreControls: false,
      closeSubagentTopics: false,
    });
    logger.info(
      `[Pause] Interrupt completed: session=${session.id}, result=${abortResult}, subagents=${pausedSubagents.length}`,
    );

    if (abortResult !== "confirmed") {
      clearPausedSession(session.id);
      keyboardManager.setPaused(false, session.id);
      pauseStateArmed = false;
      await subagentTopicInspector.resumeForParent(ctx.api, session.id).catch(() => {});
      await ctx.reply(describeAbortResult(abortResult));
      return;
    }

    pauseConfirmed = true;
    setPausedSession(session);
    setPausedSubagents(session.id, pausedSubagents);
    keyboardManager.setPaused(true, session.id);

    const keyboardState = keyboardManager.getState(session.id);
    if (keyboardState?.chatId && keyboardState.threadId !== undefined) {
      updateTopicRuntimeStateSync(keyboardState.chatId, keyboardState.threadId, {
        runState: "paused",
      });
    }

    const model = getStoredModel();
    const displayModel = formatModelForDisplay(model.providerID, model.modelID);
    const keyboard = keyboardManager.getKeyboard(session.id);
    await ctx.reply(
      [
        "⏸️ <b>Chat paused</b>",
        "",
        `💬 ${session.title}`,
        `🤖 ${displayModel}`,
        "",
        pausedSubagents.length > 0
          ? `🧩 ${pausedSubagents.length} sub-agent session${pausedSubagents.length === 1 ? "" : "s"} preserved for Resume.`
          : "The current run was interrupted safely. Your session, files, and history are still intact.",
        "",
        "Send a new prompt to continue from here, or tap <b>▶️ Resume</b> to continue without additional instructions.",
      ].join("\n"),
      {
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {}),
      },
    );
    keyboardManager.markKeyboardDelivered(session.id);
  } catch (error) {
    if (pauseStateArmed && !pauseConfirmed) {
      clearPausedSession(session.id);
      keyboardManager.setPaused(false, session.id);
      await subagentTopicInspector.resumeForParent(ctx.api, session.id).catch(() => {});
    }
    logger.error("[Pause] Failed to pause current chat:", error);
    if (pauseConfirmed) {
      const keyboard = keyboardManager.getKeyboard(session.id);
      try {
        await ctx.reply("⏸️ Chat paused. Tap ▶️ Resume to continue.", {
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
        keyboardManager.markKeyboardDelivered(session.id);
      } catch (deliveryError) {
        logger.error("[Pause] Failed to deliver paused controls:", deliveryError);
      }
    } else {
      await ctx.reply("⚠️ Pause failed. Nothing was changed beyond the attempted interruption.");
    }
  }
}

export async function resumePausedChat(
  ctx: Context,
  deps: ProcessPromptDeps,
): Promise<void> {
  const currentSession = await getEffectiveCurrentSession();
  if (!currentSession) {
    await ctx.reply("ℹ️ There is no paused chat to resume.");
    return;
  }
  const session = getPausedSession(currentSession.id);
  if (!session) {
    await ctx.reply("ℹ️ This chat is not paused.");
    return;
  }

  const pausedSubagents = getPausedSubagents(session.id);
  const resumeModel = getStoredModel();
  clearPausedSession(session.id);
  keyboardManager.setPaused(false, session.id);

  try {
    const dispatched = await processUserPrompt(
      ctx,
      buildResumePrompt(pausedSubagents),
      deps,
      [],
      resumeModel,
    );
    if (!dispatched) {
      setPausedSession(session);
      setPausedSubagents(session.id, pausedSubagents);
      keyboardManager.setPaused(true, session.id);
      await keyboardManager.sendKeyboardUpdate(ctx.chat?.id, true, session.id);
      return;
    }

    await subagentTopicInspector.resumeForParent(ctx.api, session.id).catch((error) =>
      logger.warn(
        `[Resume] Failed to resume sub-agent inspector UI: session=${session.id}`,
        error,
      ),
    );

    const displayModel = formatModelForDisplay(resumeModel.providerID, resumeModel.modelID);
    const keyboard = keyboardManager.getKeyboard(session.id);
    await ctx.reply(
      `▶️ Resuming <b>${session.title}</b> with <b>${displayModel}</b>.`,
      {
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {}),
      },
    );
  } catch (error) {
    setPausedSession(session);
    setPausedSubagents(session.id, pausedSubagents);
    keyboardManager.setPaused(true, session.id);
    await keyboardManager.sendKeyboardUpdate(ctx.chat?.id, true, session.id);
    logger.error("[Resume] Failed to resume paused chat:", error);
    await ctx.reply(
      "⚠️ Resume failed. The chat remains paused so you can change model/provider safely.",
    );
  }
}

export async function resumePausedChatWithPrompt(
  ctx: Context,
  text: string,
  deps: ProcessPromptDeps,
): Promise<boolean> {
  const currentSession = await getEffectiveCurrentSession();
  if (!currentSession || !isChatPaused(currentSession.id)) return false;
  const session = getPausedSession(currentSession.id);
  if (!session) return false;
  const prompt = text.trim();
  if (!prompt) return false;

  const pausedSubagents = getPausedSubagents(session.id);
  const selectedModel = getStoredModel();
  clearPausedSession(session.id);
  keyboardManager.setPaused(false, session.id);
  logger.info(
    `[Pause] Implicit resume from user prompt: session=${session.id}, promptLength=${prompt.length}, subagents=${pausedSubagents.length}`,
  );

  try {
    const dispatched = await processUserPrompt(
      ctx,
      buildResumePrompt(pausedSubagents, prompt),
      deps,
      [],
      selectedModel,
    );
    if (!dispatched) {
      setPausedSession(session);
      setPausedSubagents(session.id, pausedSubagents);
      keyboardManager.setPaused(true, session.id);
      await keyboardManager.sendKeyboardUpdate(ctx.chat?.id, true, session.id);
      return false;
    }

    await subagentTopicInspector.resumeForParent(ctx.api, session.id).catch(() => {});
    await keyboardManager.sendKeyboardUpdate(ctx.chat?.id, true, session.id);
    return true;
  } catch (error) {
    setPausedSession(session);
    setPausedSubagents(session.id, pausedSubagents);
    keyboardManager.setPaused(true, session.id);
    await keyboardManager.sendKeyboardUpdate(ctx.chat?.id, true, session.id);
    logger.error("[Pause] Failed implicit resume from user prompt:", error);
    await ctx.reply(
      "⚠️ The prompt could not resume the paused chat. The chat remains paused.",
    );
    return false;
  }
}
