import fs from "fs/promises";
import { readFile } from "fs/promises";
import { cleanupBotRuntime, createBot } from "../../bot/index.js";
import { createScheduledTaskDeliverySender } from "../../bot/messages/scheduled-task-delivery.js";
import { config } from "../../config.js";
import { opencodeAutoRestartService } from "../../opencode/auto-restart.js";
import { notifyOpencodeReadyIfHealthy, registerOpenCodeReadyRefreshHandler } from "../../opencode/ready-refresh.js";
import { flushSettings, getGlobalSettings, loadSettings } from "../stores/settings-store.js";
import { scheduledTaskRuntime } from "../services/scheduled-task-runtime-service.js";
import { migrateLegacyCustomProviderCredentials, syncOpenCodeCustomConfig } from "../services/custom-provider-service.js";
import { refreshFreeLlmCatalog } from "../services/free-llm-catalog-service.js";
import { startFreeLlmCatalogRefreshService, stopFreeLlmCatalogRefreshService } from "../services/free-llm-catalog-refresh-service.js";
import { startModelCatalogRefreshService, stopModelCatalogRefreshService } from "../services/model-catalog-refresh-service.js";
import { initializeGithubIntegration } from "../services/github-integration-service.js";
import { initializeTailscaleIntegration, stopTailscaleIntegration } from "../services/tailscale-integration-service.js";
import { cleanupLegacyUserConfiguration } from "../services/persistent-state-registry.js";
import { migrateBundledExtensionsToManagedState } from "../services/extension-defaults-service.js";
import { listStoredExtensions } from "../services/extension-store.js";
import { migrateLegacyImageAiCredentials } from "../services/image-ai-provider-service.js";
import { getRuntimeMode } from "../../runtime/mode.js";
import { getRuntimePaths } from "../../runtime/paths.js";
import { clearServiceStateFile } from "../../runtime/service/manager.js";
import { getServiceStateFilePathFromEnv, isServiceChildProcess } from "../../runtime/service/env.js";
import { flushLogger, getLogFilePath, initializeLogger, logger } from "../../utils/logger.js";
import { RuntimeObservabilityWatchdog } from "../../utils/runtime-observability.js";
import { opencodeMemoryRecoveryService } from "../services/opencode-memory-recovery-service.js";
import { safeBackgroundTask } from "../../utils/safe-background-task.js";
import { reconcileTopicWorkspaces } from "../services/telegram-topic-workspace-service.js";
import { listTelegramTopicBindings } from "../services/telegram-topic-store.js";
import { listTopicRuntimeStates, removeTopicRuntimeState } from "../stores/topic-runtime-state-store.js";
import { initializeNativeCore, shutdownNativeCore } from "../../core/native-core-service.js";

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
  if (process.env.CONTROL_APPLICATION_IPC === "1") {
    logger.info("[TelegramTopics] Distributed migration preserves unbound workspaces and runtime state");
    return;
  }
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
  const extensionMigration = await migrateBundledExtensionsToManagedState();
  if (extensionMigration.seeded > 0) {
    logger.info(`[Extensions] Migrated bundled runtime Extensions into bot state: seeded=${extensionMigration.seeded}`);
  }

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
  await migrateLegacyImageAiCredentials().catch((error) => {
    logger.warn("[ImageAI] Could not migrate legacy credentials into Credential Vault", error);
    return 0;
  });
  await reconcileOrphanedTopicState();
  const githubConfigured = await initializeGithubIntegration().catch((error) => {
    logger.warn(
      "[GithubIntegration] Could not initialize stored GitHub integration; continuing without GitHub integration",
      error,
    );
    return false;
  });
  logger.info(`[GithubIntegration] ${githubConfigured ? "configured" : "not configured"}`);
  await refreshFreeLlmCatalog().catch((error) => {
    logger.warn("[FreeLLMCatalog] Startup refresh failed; cached/empty catalog will be used", error);
  });
  await migrateLegacyCustomProviderCredentials().catch((error) => {
    logger.warn("[CustomProvider] Could not migrate legacy provider credentials; continuing with legacy compatibility", error);
    return 0;
  });
  const tailscaleConnected = await initializeTailscaleIntegration().catch((error) => {
    logger.warn("[Tailscale] Could not initialize stored Tailnet integration; continuing without Tailnet access", error);
    return false;
  });
  logger.info(`[Tailscale] ${tailscaleConnected ? "connected" : "not connected"}`);
  const managedConfigPath = await syncOpenCodeCustomConfig();
  if (!managedConfigPath.trim()) {
    throw new Error("Managed OpenCode config path is empty; refusing to start without runtime policy");
  }
  process.env.OPENCODE_CONFIG = managedConfigPath;
  const managedPlugins = (await listStoredExtensions())
    .filter((extension) => extension.resource.kind === "plugin").length;
  logger.info(
    `[Extensions] Managed OpenCode config ready: path=${managedConfigPath}, plugins=${managedPlugins}`,
  );
  startModelCatalogRefreshService();
  startFreeLlmCatalogRefreshService();
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
  const coreBindings = (await listTelegramTopicBindings()).map((binding) => ({
    chatId: binding.chatId,
    threadId: binding.threadId,
    sessionId: binding.sessionId,
    directory: binding.directory,
  }));
  await initializeNativeCore(bot.api, coreBindings);
  if(process.env.CONTROL_APPLICATION_IPC==="1"){
    const {opencodeReadyLifecycle}=await import("../../opencode/ready-lifecycle.js");
    let inspected=false;
    const inspectOnce=async()=>{if(inspected)return;inspected=true;const {inspectExistingTopicBindings}=await import("../../control-plane/topic-classification.js");await inspectExistingTopicBindings();};
    if(opencodeReadyLifecycle.isReady())void inspectOnce();
    else opencodeReadyLifecycle.onReady(inspectOnce);
    // One startup inventory for migration planning: identities only, never conversation,
    // workspace contents, credentials, or an idle outbound diagnostics loop.
    for(const binding of coreBindings)logger.info(`[DistributedInventory] topic chat=${binding.chatId} thread=${binding.threadId} session=${binding.sessionId}`);
    const {nodeBindings}=await import("../../control-plane/node-bindings.js");
    const {readGlobalSnapshot}=await import("../../control-plane/global-state.js");
    const snapshot=await readGlobalSnapshot();
    logger.info(`[DistributedInventory] global revision=${snapshot.revision} hash=${snapshot.hash} topicBindings=${coreBindings.length} nodeBindings=${(await nodeBindings.list()).filter(node=>node.status!=="retired").length}`);
  }
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
  if(process.env.CONTROL_CLUSTER_BOOTSTRAP_ENABLED==="1"){
    safeBackgroundTask({taskName:"app.workerClusterBootstrap",task:async()=>{
      const {topicNodeLifecycle}=await import("../../control-plane/topic-node-lifecycle.js");
      const workers=await topicNodeLifecycle.bootstrapPool();
      for(const worker of workers)logger.info(`[WorkerCluster] slot=${worker.slot} node=${worker.nodeId} generation=${worker.generation} status=${worker.status} project=${worker.projectId} service=${worker.serviceId} volume=${worker.volumeId} revision=${worker.currentRevision}`);
    }});
  }
  const runtimeObservabilityWatchdog = new RuntimeObservabilityWatchdog();
  runtimeObservabilityWatchdog.start();
  safeBackgroundTask({
    taskName: "app.opencodeStartup",
    task: async () => {
      const monitorStarted = await opencodeAutoRestartService.start();
      if (!monitorStarted) {
        await notifyOpencodeReadyIfHealthy("startup");
        return;
      }
      opencodeMemoryRecoveryService.start();
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
    stopFreeLlmCatalogRefreshService();
    cleanupBotRuntime(`app_shutdown_${signal.toLowerCase()}`);
    void shutdownNativeCore().catch((error) => logger.warn("[Core] Failed to shut down cleanly", error));
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
      onStart: (startedBotInfo) => {
        logger.info(`Bot @${startedBotInfo.username} started!`);
        if(process.env.CONTROL_APPLICATION_IPC==="1")process.send?.({channel:"control-application-ready"});
      },
    });
  } finally {
    runtimeObservabilityWatchdog.stop();
    stopModelCatalogRefreshService();
    stopFreeLlmCatalogRefreshService();
    process.off("unhandledRejection", unhandledRejectionHandler);
    process.off("uncaughtException", uncaughtExceptionHandler);
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    if (shutdownTimeout) {
      clearTimeout(shutdownTimeout);
      shutdownTimeout = null;
    }
    cleanupBotRuntime("app_shutdown_complete");
    await shutdownNativeCore().catch((error) => logger.warn("[Core] Failed to shut down cleanly", error));
    opencodeAutoRestartService.stop();
    scheduledTaskRuntime.shutdown();
    await stopTailscaleIntegration().catch((error) => logger.warn("[Tailscale] Failed to stop tailscaled cleanly", error));
    await clearManagedServiceState().catch((error) =>
      logger.warn("[App] Failed to clear managed service state", error),
    );
    await flushSettings();
  }
}
