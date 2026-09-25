import fs from "fs/promises";
import { readFile } from "fs/promises";
import { cleanupBotRuntime, createBot } from "../../bot/index.js";
import { createScheduledTaskDeliverySender } from "../../bot/messages/scheduled-task-delivery.js";
import { config } from "../../config.js";
import { opencodeAutoRestartService } from "../../opencode/auto-restart.js";
import { notifyOpencodeReadyIfHealthy, registerOpenCodeReadyRefreshHandler } from "../../opencode/ready-refresh.js";
import { flushSettings, getGlobalSettings, loadSettings } from "../stores/settings-store.js";
import { scheduledTaskRuntime } from "../services/scheduled-task-runtime-service.js";
import { syncOpenCodeCustomConfig } from "../services/custom-provider-service.js";
import { startModelCatalogRefreshService, stopModelCatalogRefreshService } from "../services/model-catalog-refresh-service.js";
import { initializeGithubIntegration } from "../services/github-integration-service.js";
import { initializeRailwayIntegration } from "../services/railway-integration-service.js";
import { initializeTailscaleIntegration, stopTailscaleIntegration } from "../services/tailscale-integration-service.js";
import { cleanupLegacyUserConfiguration } from "../services/persistent-state-registry.js";
import { getRuntimeMode } from "../../runtime/mode.js";
import { getRuntimePaths } from "../../runtime/paths.js";
import { clearServiceStateFile } from "../../runtime/service/manager.js";
import { getServiceStateFilePathFromEnv, isServiceChildProcess } from "../../runtime/service/env.js";
import { flushLogger, getLogFilePath, initializeLogger, logger } from "../../utils/logger.js";
import { RuntimeObservabilityWatchdog } from "../../utils/runtime-observability.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { reconcileTopicWorkspaces } from "../services/telegram-topic-workspace-service.js";
import { listTelegramTopicBindings } from "../services/telegram-topic-store.js";
import { listTopicRuntimeStates, removeTopicRuntimeState } from "../stores/topic-runtime-state-store.js";

const SHUTDOWN_TIMEOUT_MS = 5000;
const SETTINGS_FLUSH_TIMEOUT_MS = 1000;
const LOG_FLUSH_TIMEOUT_MS = 1000;

async function getBotVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL("../../../package.json", import.meta.url);
    const packageJsonContent = await readFile(packageJsonPath, "utf-8");
    const packageJson = JSON.parse(packageJsonContent) as { version?: string };
    return packageJson.version ?? "unknown";
  } catch (error) {
    logger.warn("[App] Failed to read bot version", error);
    return "unknown";
  }
}

/**
 * Deletes topic workspaces and Topic runtime states that no live binding owns.
 * Interrupted or previously partial deletes leaked these orphans onto the
 * persistent volume; startup reconcile guarantees every restart converges.
 */
async function reconcileOrphanedTopicState(): Promise<void> {
  try {
    const bindings = await listTelegramTopicBindings();
    const referencedDirectories = new Set(bindings.map((binding) => binding.directory));
    const removedWorkspaces = await reconcileTopicWorkspaces(referencedDirectories);
    const liveTopicKeys = new Set(bindings.map((binding) => `${binding.chatId}:${binding.threadId}`));
    let removedStates = 0;
    for (const state of await listTopicRuntimeStates()) {
      if (liveTopicKeys.has(`${state.chatId}:${state.threadId}`)) continue;
      await removeTopicRuntimeState(state.chatId, state.threadId);
      removedStates += 1;
    }
    if (removedWorkspaces.length > 0 || removedStates > 0) {
      logger.info(
        `[TelegramTopics] Startup reconcile removed orphaned workspaces=${removedWorkspaces.length}, runtimeStates=${removedStates}`,
      );
    }
  } catch (error) {
    logger.warn("[TelegramTopics] Startup orphan reconciliation failed; continuing", error);
  }
}

export async function startBotApp(): Promise<void> {
  await initializeLogger();
  const mode = getRuntimeMode();
  const runtimePaths = getRuntimePaths();
  const version = await getBotVersion();
  const logFilePath = getLogFilePath();
  logger.info(`Starting OpenCode Telegram Bot v${version}...`);
  logger.info(`Node.js ${process.version} on ${process.platform} ${process.arch}`);
  logger.info(`Config loaded from ${runtimePaths.envFilePath}`);
  if (logFilePath) logger.info(`Logs are written to ${logFilePath}`);
  logger.info(`Allowed User ID: ${config.telegram.allowedUserId}`);
  logger.debug(`[Runtime] Application start mode: ${mode}`);
  await cleanupLegacyUserConfiguration();

  let serviceStateCleared = false;
  const clearManagedServiceState = async (): Promise<void> => {
    if (!isServiceChildProcess() || serviceStateCleared) return;
    const stateFilePath = getServiceStateFilePathFromEnv();
    if (!stateFilePath) return;
    try {
      await fs.access(stateFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        serviceStateCleared = true;
        return;
      }
      throw error;
    }
    await clearServiceStateFile(stateFilePath);
    serviceStateCleared = true;
  };
  const flushSettingsWithTimeout = (): Promise<void> =>
    Promise.race([
      flushSettings(),
      new Promise<void>((resolve) => setTimeout(resolve, SETTINGS_FLUSH_TIMEOUT_MS)),
    ]);
  const flushLoggerWithTimeout = (): Promise<void> =>
    Promise.race([
      flushLogger(),
      new Promise<void>((resolve) => setTimeout(resolve, LOG_FLUSH_TIMEOUT_MS)),
    ]);

  const unhandledRejectionHandler = (reason: unknown): void => {
    logger.error("[App] Unhandled promise rejection", reason);
  };
  const uncaughtExceptionHandler = (error: Error): void => {
    logger.error("[App] Uncaught exception", error);
    void clearManagedServiceState()
      .catch(() => {})
      .then(() => flushSettingsWithTimeout())
      .then(() => flushLoggerWithTimeout())
      .finally(() => process.exit(1));
  };
  process.on("unhandledRejection", unhandledRejectionHandler);
  process.on("uncaughtException", uncaughtExceptionHandler);

  await loadSettings();
  await reconcileOrphanedTopicState();
  const githubConfigured = await initializeGithubIntegration().catch((error) => {
    logger.warn(
      "[GithubIntegration] Could not initialize stored GitHub integration; continuing without GitHub integration",
      error,
    );
    return false;
  });
  logger.info(`[GithubIntegration] ${githubConfigured ? "configured" : "not configured"}`);
  const railwayConfigured = await initializeRailwayIntegration().catch((error) => {
    logger.warn(
      "[RailwayIntegration] Could not initialize stored Railway integration; continuing without Railway integration",
      error,
    );
    return false;
  });
  logger.info(`[RailwayIntegration] ${railwayConfigured ? "configured" : "not configured"}`);
  const tailscaleConnected = await initializeTailscaleIntegration().catch((error) => {
    logger.warn("[Tailscale] Could not initialize stored Tailnet integration; continuing without Tailnet access", error);
    return false;
  });
  logger.info(`[Tailscale] ${tailscaleConnected ? "connected" : "not connected"}`);
  try {
    process.env.OPENCODE_CONFIG = await syncOpenCodeCustomConfig();
  } catch (error) {
    logger.warn("[CustomProvider] Could not prepare provider config; continuing without it", error);
  }
  startModelCatalogRefreshService();
  registerOpenCodeReadyRefreshHandler();
  const bot = createBot();

  // Re-pin only the exact bot-owned Main navigation anchors. These IDs are
  // persisted exclusively by KeyboardManager's root/All path; real Topic
  // messages are rejected before persistence, so coding Topic pins are never
  // touched here. This also repairs an unpinned Main panel immediately after a
  // restart instead of waiting for the user to run /start again.
  const mainNavigationMessageIds = getGlobalSettings().mainNavigationMessageIds ?? {};
  for (const [chatIdText, messageId] of Object.entries(mainNavigationMessageIds)) {
    const chatId = Number(chatIdText);
    if (
      !Number.isSafeInteger(chatId) ||
      typeof messageId !== "number" ||
      !Number.isInteger(messageId) ||
      messageId <= 0
    ) {
      continue;
    }
    try {
      await bot.api.pinChatMessage(chatId, messageId, { disable_notification: true });
      logger.info(
        `[TelegramKeyboard] Startup restored Main navigation pin in All/root: chat=${chatId}, message=${messageId}`,
      );
    } catch (error) {
      logger.warn(
        `[TelegramKeyboard] Startup could not restore Main navigation pin: chat=${chatId}, message=${messageId}`,
        error,
      );
    }
  }

  const botInfo = await bot.api.getMe();
  logger.info(
    `[TelegramTopics] Bot capabilities: has_topics_enabled=${botInfo.has_topics_enabled ?? false}, allows_users_to_create_topics=${botInfo.allows_users_to_create_topics ?? false}`,
  );
  if (!botInfo.has_topics_enabled) {
    logger.warn(
      "[TelegramTopics] Private Topics/Threaded Mode is disabled for this bot. Enable Threaded Mode in @BotFather; code cannot create the native General topic UI while this capability is disabled.",
    );
  }
  await scheduledTaskRuntime.initialize(
    bot,
    createScheduledTaskDeliverySender(bot.api, config.telegram.allowedUserId),
  );
  const runtimeObservabilityWatchdog = new RuntimeObservabilityWatchdog();
  runtimeObservabilityWatchdog.start();
  safeBackgroundTask({
    taskName: "app.opencodeStartup",
    task: async () => {
      const monitorStarted = await opencodeAutoRestartService.start();
      if (!monitorStarted) await notifyOpencodeReadyIfHealthy("startup");
    },
  });

  let shutdownStarted = false;
  let shutdownTimeout: ReturnType<typeof setTimeout> | null = null;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info(`[App] Received ${signal}, shutting down...`);
    runtimeObservabilityWatchdog.stop();
    stopModelCatalogRefreshService();
    cleanupBotRuntime(`app_shutdown_${signal.toLowerCase()}`);
    opencodeAutoRestartService.stop();
    scheduledTaskRuntime.shutdown();
    void stopTailscaleIntegration().catch((error) => logger.warn("[Tailscale] Failed to stop tailscaled cleanly", error));
    shutdownTimeout = setTimeout(() => {
      logger.warn(`[App] Shutdown did not finish in ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit.`);
      void flushSettingsWithTimeout()
        .then(() => flushLoggerWithTimeout())
        .finally(() => process.exit(0));
    }, SHUTDOWN_TIMEOUT_MS);
    shutdownTimeout.unref?.();
    try {
      bot.stop();
    } catch (error) {
      logger.warn("[App] Failed to stop Telegram bot cleanly", error);
    }
    void clearManagedServiceState().catch((error) =>
      logger.warn("[App] Failed to clear managed service state", error),
    );
  };
  const handleSigint = (): void => shutdown("SIGINT");
  const handleSigterm = (): void => shutdown("SIGTERM");
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  const webhookInfo = await bot.api.getWebhookInfo();
  if (webhookInfo.pending_update_count > 0) {
    logger.info(
      `[Bot] Resuming ~${webhookInfo.pending_update_count} update(s) queued while the bot was offline; stale-message middleware will discard expired messages`,
    );
  }
  if (webhookInfo.url) {
    logger.info(`[Bot] Webhook detected: ${webhookInfo.url}, removing...`);
    await bot.api.deleteWebhook();
    logger.info("[Bot] Webhook removed, switching to long polling");
  }

  try {
    await bot.start({
      onStart: (startedBotInfo) => logger.info(`Bot @${startedBotInfo.username} started!`),
    });
  } finally {
    runtimeObservabilityWatchdog.stop();
    stopModelCatalogRefreshService();
    process.off("unhandledRejection", unhandledRejectionHandler);
    process.off("uncaughtException", uncaughtExceptionHandler);
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout);
      shutdownTimeout = null;
    }
    cleanupBotRuntime("app_shutdown_complete");
    opencodeAutoRestartService.stop();
    scheduledTaskRuntime.shutdown();
    await stopTailscaleIntegration().catch((error) => logger.warn("[Tailscale] Failed to stop tailscaled cleanly", error));
    await clearManagedServiceState().catch((error) =>
      logger.warn("[App] Failed to clear managed service state", error),
    );
    await flushSettings();
  }
}
