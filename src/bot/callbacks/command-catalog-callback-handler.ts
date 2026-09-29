import path from "node:path";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { CommandCatalogItem } from "../../app/services/command-catalog-service.js";
import { config } from "../../config.js";
import { loadCommandCatalog } from "../../app/services/command-catalog-service.js";
import {
  getEffectiveCurrentSession,
  getCurrentSessionDirectory,
} from "../../app/services/session-service.js";
import { interactionManager } from "../../app/managers/interaction-manager.js";
import type { InteractionState } from "../../app/types/interaction.js";
import { summaryAggregator } from "../../app/managers/summary-aggregation-manager.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { cancelMenu } from "./feedback.js";
import { foregroundSessionState } from "../../app/managers/foreground-session-state-manager.js";
import { assistantRunState } from "../../app/managers/assistant-run-state-manager.js";
import {
  attachToSession,
  markAttachedSessionBusy,
  markAttachedSessionIdle,
} from "../../app/services/attach-service.js";
import { externalUserInputSuppressionManager } from "../../app/managers/external-input-suppression-manager.js";
import { opencodeClient } from "../../opencode/client.js";
import { beginCoreRunForSession, captureCurrentCoreBindingOwner, dispatchCoreOwnedTask, finishCoreRunForSession, isCurrentCoreSessionRoute } from "../../core/native-core-service.js";
import { createCoreSessionApi } from "../services/core-session-api.js";
import {
  buildCommandsConfirmKeyboard,
  buildCommandsListKeyboard,
  calculateCommandsPaginationRange,
  COMMANDS_CALLBACK_CANCEL,
  COMMANDS_CALLBACK_EXECUTE,
  COMMANDS_CALLBACK_PREFIX,
  formatCommandsSelectText,
  formatExecutingCommandMessage,
  parseCommandPageCallback,
  parseCommandSelectCallback,
} from "../menus/command-catalog-menu.js";

interface CommandsListMetadata {
  flow: "commands";
  stage: "list";
  messageId: number;
  projectDirectory: string;
  commands: CommandCatalogItem[];
  page: number;
}

interface CommandsConfirmMetadata {
  flow: "commands";
  stage: "confirm";
  messageId: number;
  projectDirectory: string;
  commandName: string;
}

export type CommandsMetadata = CommandsListMetadata | CommandsConfirmMetadata;
export interface ExecuteCommandParams { projectDirectory: string; commandName: string; argumentsText: string; }
export interface ExecuteCommandDeps { bot: Bot<Context>; ensureEventSubscription: (directory: string) => Promise<void>; }

const commandMenus = new Map<number, CommandsMetadata>();

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function saveCommandsMenu(metadata: CommandsMetadata): void { commandMenus.set(metadata.messageId, metadata); }
export function registerCommandsMenu(metadata: CommandsMetadata): void { saveCommandsMenu(metadata); }
export function clearCommandsMenu(messageId: number | null): void { if (messageId !== null) commandMenus.delete(messageId); }

function parseCommandItems(value: unknown): CommandCatalogItem[] | null {
  if (!Array.isArray(value)) return null;
  const commands: CommandCatalogItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const commandName = (item as { name?: unknown }).name;
    if (typeof commandName !== "string" || !commandName.trim()) return null;
    const description = (item as { description?: unknown }).description;
    commands.push({ name: commandName, description: typeof description === "string" ? description : undefined });
  }
  return commands;
}

export function parseCommandsMetadata(state: InteractionState | null): CommandsMetadata | null {
  if (!state || state.kind !== "custom") return null;
  const flow = state.metadata.flow;
  const stage = state.metadata.stage;
  const messageId = state.metadata.messageId;
  const projectDirectory = state.metadata.projectDirectory;
  if (flow !== "commands" || typeof messageId !== "number" || typeof projectDirectory !== "string") return null;
  if (stage === "list") {
    const commands = parseCommandItems(state.metadata.commands);
    if (!commands) return null;
    const page = typeof state.metadata.page === "number" && Number.isInteger(state.metadata.page) ? Math.max(0, state.metadata.page) : 0;
    return { flow, stage, messageId, projectDirectory, commands, page };
  }
  if (stage === "confirm") {
    const commandName = state.metadata.commandName;
    if (typeof commandName !== "string" || !commandName.trim()) return null;
    return { flow, stage, messageId, projectDirectory, commandName };
  }
  return null;
}

export function clearCommandsInteraction(reason: string): void {
  const metadata = parseCommandsMetadata(interactionManager.getSnapshot());
  if (metadata) interactionManager.clear(reason);
}

async function recoverCommandsListMetadata(ctx: Context): Promise<CommandsListMetadata | null> {
  const messageId = getCallbackMessageId(ctx);
  if (messageId === null) return null;
  const cached = commandMenus.get(messageId);
  if (cached?.stage === "list") return cached;
  const projectDirectory = getCurrentSessionDirectory();
  if (!projectDirectory) return null;
  const commands = await loadCommandCatalog(projectDirectory);
  if (commands.length === 0) return null;
  const pageSize = config.bot.commandsListLimit;
  const { page } = calculateCommandsPaginationRange(commands.length, 0, pageSize);
  const recovered: CommandsListMetadata = { flow: "commands", stage: "list", messageId, projectDirectory, commands, page };
  saveCommandsMenu(recovered);
  interactionManager.start({ kind: "custom", expectedInput: "callback", metadata: { ...recovered } });
  logger.warn(`[Commands] Recovered stale custom-command menu state: messageId=${messageId}`);
  return recovered;
}

async function isSessionBusy(sessionId: string, directory: string): Promise<boolean> {
  try {
    const { data, error } = await opencodeClient.session.status({ directory });
    if (error || !data) {
      logger.warn("[Commands] Failed to check session status before command:", error);
      return false;
    }
    const sessionStatus = (data as Record<string, { type?: string }>)[sessionId];
    return sessionStatus?.type === "busy";
  } catch (err) {
    logger.warn("[Commands] Error checking session status before command:", err);
    return false;
  }
}

export async function executeCommand(ctx: Context, deps: ExecuteCommandDeps, params: ExecuteCommandParams): Promise<void> {
  if (!ctx.chat) return;
  let session;
  try {
    const owner = captureCurrentCoreBindingOwner();
    if (owner.directory !== path.resolve(params.projectDirectory)) throw new Error("command directory differs from Core binding");
    session = await getEffectiveCurrentSession();
    if (!session || session.id !== owner.sessionId || path.resolve(session.directory) !== owner.directory) {
      throw new Error("Command session does not match its Core Topic binding");
    }
  } catch (error) {
    logger.warn("[Commands] Rejected command outside its Core Topic binding", error);
    await ctx.reply(t("commands.execute_error"));
    return;
  }
  const args = params.argumentsText.trim();
  const executingMessage = formatExecutingCommandMessage(params.commandName, args);
  await ctx.reply(executingMessage.text, { entities: executingMessage.entities });
  await attachToSession({ bot: deps.bot, chatId: ctx.chat.id, session, ensureEventSubscription: deps.ensureEventSubscription });
  if (await isSessionBusy(session.id, session.directory)) {
    await ctx.reply(t("bot.session_busy"));
    return;
  }

  const currentAgent = await resolveProjectAgent(getStoredAgent());
  const storedModel = getStoredModel();
  const model = storedModel.providerID && storedModel.modelID ? `${storedModel.providerID}/${storedModel.modelID}` : undefined;
  let coreRun;
  try {
    coreRun = await beginCoreRunForSession(session.id, session.directory, "session_command");
  } catch (error) {
    logger.warn(`[Commands] Core rejected command admission: session=${session.id}`, error);
    await ctx.reply(t("commands.execute_error"));
    return;
  }
  foregroundSessionState.markBusy(session.id, session.directory);
  await markAttachedSessionBusy(session.id);
  assistantRunState.startRun(session.id, {
    startedAt: Date.now(),
    configuredAgent: currentAgent,
    configuredProviderID: storedModel.providerID,
    configuredModelID: storedModel.modelID,
  }, coreRun.runId);
  summaryAggregator.beginRun(session.id);
  externalUserInputSuppressionManager.register(session.id, args ? `/${params.commandName} ${args}` : `/${params.commandName}`);

  safeBackgroundTask({
    taskName: "session.command",
    task: () => dispatchCoreOwnedTask(coreRun, `command:${params.commandName}`, ({ signal }) =>
      opencodeClient.session.command({
        sessionID: session.id,
        directory: session.directory,
        command: params.commandName,
        arguments: args,
        agent: currentAgent,
        ...(model !== undefined ? { model } : {}),
        ...(storedModel.variant !== undefined ? { variant: storedModel.variant } : {}),
      }, { signal }),
    ),
    onSuccess: ({ error }) => {
      if (!isCurrentCoreSessionRoute(coreRun)) return;
      if (error) {
        foregroundSessionState.markIdle(session.id);
        void markAttachedSessionIdle(session.id);
        assistantRunState.clearRun(session.id, "session_command_api_error");
        finishCoreRunForSession(session.id);
        logger.error("[Commands] OpenCode API returned an error for session.command", { sessionId: session.id, command: params.commandName, args });
        logger.error("[Commands] session.command error details:", error);
        void createCoreSessionApi(ctx.api, session.id).sendMessage(ctx.chat!.id, t("commands.execute_error")).catch(() => {});
        return;
      }
      logger.info(`[Commands] session.command completed: session=${session.id}, command=/${params.commandName}`);
    },
    onError: (error) => {
      if (!isCurrentCoreSessionRoute(coreRun)) return;
      foregroundSessionState.markIdle(session.id);
      void markAttachedSessionIdle(session.id);
      assistantRunState.clearRun(session.id, "session_command_background_error");
      finishCoreRunForSession(session.id);
      logger.error("[Commands] session.command background task failed", { sessionId: session.id, command: params.commandName, args });
      logger.error("[Commands] session.command background failure details:", error);
      void createCoreSessionApi(ctx.api, session.id).sendMessage(ctx.chat!.id, t("commands.execute_error")).catch(() => {});
    },
  });
}

export async function handleCommandsCallback(ctx: Context, deps: ExecuteCommandDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(COMMANDS_CALLBACK_PREFIX)) return false;
  const callbackMessageId = getCallbackMessageId(ctx);
  if (data === COMMANDS_CALLBACK_CANCEL) {
    clearCommandsMenu(callbackMessageId);
    clearCommandsInteraction("commands_cancelled");
    await ctx.answerCallbackQuery().catch(() => {});
    await cancelMenu(ctx).catch(() => {});
    return true;
  }

  let metadata = callbackMessageId === null ? null : commandMenus.get(callbackMessageId) ?? null;
  if (!metadata) {
    metadata = parseCommandsMetadata(interactionManager.getSnapshot());
    if (metadata && callbackMessageId !== null && metadata.messageId !== callbackMessageId) metadata = null;
  }
  if (!metadata) metadata = await recoverCommandsListMetadata(ctx);
  if (!metadata || callbackMessageId === null || metadata.messageId !== callbackMessageId) {
    await ctx.answerCallbackQuery({ text: t("commands.inactive_callback"), show_alert: true });
    return true;
  }

  try {
    if (data === COMMANDS_CALLBACK_EXECUTE) {
      if (metadata.stage !== "confirm") {
        await ctx.answerCallbackQuery({ text: t("commands.inactive_callback"), show_alert: true });
        return true;
      }
      clearCommandsMenu(metadata.messageId);
      clearCommandsInteraction("commands_execute_clicked");
      await ctx.answerCallbackQuery({ text: t("commands.execute_callback") });
      await ctx.editMessageText(`▶️ /${metadata.commandName}\n\nExecution started.`, {
        reply_markup: new InlineKeyboard().text("← Commands", "commands:list_back").text("🏠 Home", "main:home"),
      }).catch(() => {});
      await executeCommand(ctx, deps, {
        projectDirectory: metadata.projectDirectory,
        commandName: metadata.commandName,
        argumentsText: "",
      });
      return true;
    }

    const page = parseCommandPageCallback(data);
    if (page !== null) {
      if (metadata.stage !== "list") {
        await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
        return true;
      }
      const pageSize = config.bot.commandsListLimit;
      const { page: normalizedPage, totalPages } = calculateCommandsPaginationRange(metadata.commands.length, page, pageSize);
      if (page >= totalPages || page < 0) {
        await ctx.answerCallbackQuery({ text: t("commands.page_empty_callback") });
        return true;
      }
      const nextMetadata: CommandsListMetadata = { ...metadata, page: normalizedPage };
      saveCommandsMenu(nextMetadata);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(formatCommandsSelectText(normalizedPage), {
        reply_markup: buildCommandsListKeyboard(metadata.commands, normalizedPage, pageSize),
      });
      interactionManager.transition({ expectedInput: "callback", metadata: { ...nextMetadata } });
      return true;
    }

    const commandIndex = parseCommandSelectCallback(data);
    if (commandIndex === null || metadata.stage !== "list") {
      await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
      return true;
    }
    const selectedCommand = metadata.commands[commandIndex];
    if (!selectedCommand) {
      await ctx.answerCallbackQuery({ text: t("commands.inactive_callback"), show_alert: true });
      return true;
    }

    const confirmMetadata: CommandsConfirmMetadata = {
      flow: "commands",
      stage: "confirm",
      messageId: metadata.messageId,
      projectDirectory: metadata.projectDirectory,
      commandName: selectedCommand.name,
    };
    saveCommandsMenu(confirmMetadata);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t("commands.confirm", { command: `/${selectedCommand.name}` }), {
      reply_markup: buildCommandsConfirmKeyboard(),
    });
    interactionManager.transition({ expectedInput: "mixed", metadata: { ...confirmMetadata } });
    return true;
  } catch (error) {
    logger.error("[Commands] Error handling command callback:", error);
    clearCommandsMenu(callbackMessageId);
    clearCommandsInteraction("commands_callback_error");
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    return true;
  }
}
