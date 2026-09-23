import { attachManager } from "../managers/attach-manager.js";
import { foregroundSessionState } from "../managers/foreground-session-state-manager.js";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { getCurrentSession } from "./session-service.js";
import { reconcileBusyStateNow } from "./busy-reconciliation-service.js";
import { listTopicRuntimeStates } from "../stores/topic-runtime-state-store.js";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";

/** Returns busy state for the current Topic; Main remains globally busy. */
export function isForegroundBusy(): boolean {
  const sessionId = getCurrentSession()?.id;
  if (sessionId) return assistantRunState.hasActiveRun(sessionId) || foregroundSessionState.getBusySessions().some((session) => session.sessionId === sessionId) || attachManager.getSnapshot()?.sessionId === sessionId && attachManager.isBusy();
  return foregroundSessionState.isBusy() || attachManager.isBusy() || assistantRunState.hasActiveRuns();
}

/** Global busy state across every Telegram Topic/session. */
export function isAnyForegroundBusy(): boolean {
  return foregroundSessionState.isBusy() || attachManager.isBusy() || assistantRunState.hasActiveRuns();
}

function getBusyDirectories(): string[] {
  const directories = new Set<string>();
  for (const session of foregroundSessionState.getBusySessions()) directories.add(session.directory);
  const attached = attachManager.getSnapshot();
  if (attached?.busy) directories.add(attached.directory);
  return [...directories];
}

export async function reconcileForegroundBusyState(): Promise<void> {
  if (!isForegroundBusy()) return;
  for (const directory of getBusyDirectories()) {
    try { await reconcileBusyStateNow(directory); }
    catch (error) { logger.warn("[BusyGuard] Failed to reconcile foreground busy state", error); }
  }
}

export async function reconcileAllForegroundBusyState(): Promise<void> {
  if (!isAnyForegroundBusy()) return;
  for (const directory of getBusyDirectories()) {
    try { await reconcileBusyStateNow(directory); }
    catch (error) { logger.warn("[BusyGuard] Failed to reconcile global foreground busy state", error); }
  }
}

export type OpenCodeActivityState = "idle" | "busy" | "unavailable";

/**
 * Cross-check OpenCode itself before an instance-wide reload. This catches
 * child/background sessions that are active inside a Topic directory but are
 * intentionally not represented by Telegram's foreground trackers.
 */
export async function getOpenCodeActivityState(): Promise<OpenCodeActivityState> {
  const directories = new Set<string>();
  const current = getCurrentSession();
  if (current?.directory) directories.add(current.directory);
  for (const session of foregroundSessionState.getBusySessions()) directories.add(session.directory);
  const attached = attachManager.getSnapshot();
  if (attached?.directory) directories.add(attached.directory);

  try {
    for (const state of await listTopicRuntimeStates()) {
      const directory = state.settings.workspaceDirectory ?? state.settings.session?.directory;
      if (directory) directories.add(directory);
    }
  } catch (error) {
    logger.debug("[BusyGuard] Failed to enumerate Topic directories for OpenCode activity check", error);
  }

  if (directories.size === 0) {
    try {
      const { data, error } = await opencodeClient.session.status();
      if (error || !data) return "unavailable";
      return Object.values(data).some((status) => status.type === "busy" || status.type === "retry")
        ? "busy"
        : "idle";
    } catch {
      return "unavailable";
    }
  }

  let successfulChecks = 0;
  for (const directory of directories) {
    try {
      const { data, error } = await opencodeClient.session.status({ directory });
      if (error || !data) continue;
      successfulChecks += 1;
      if (Object.values(data).some((status) => status.type === "busy" || status.type === "retry")) {
        return "busy";
      }
    } catch (error) {
      logger.debug("[BusyGuard] OpenCode activity check failed: directory=" + directory, error);
    }
  }

  return successfulChecks > 0 ? "idle" : "unavailable";
}
