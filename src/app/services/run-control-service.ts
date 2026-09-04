import { attachManager } from "../managers/attach-manager.js";
import { foregroundSessionState } from "../managers/foreground-session-state-manager.js";
import { assistantRunState } from "../managers/assistant-run-state-manager.js";
import { getCurrentSession } from "./session-service.js";
import { reconcileBusyStateNow } from "./busy-reconciliation-service.js";
import { logger } from "../../utils/logger.js";

/** Returns busy state for the current Topic; Main remains globally busy. */
export function isForegroundBusy(): boolean {
  const sessionId = getCurrentSession()?.id;
  if (sessionId) return assistantRunState.hasActiveRun(sessionId) || foregroundSessionState.getBusySessions().some((session) => session.sessionId === sessionId) || attachManager.getSnapshot()?.sessionId === sessionId && attachManager.isBusy();
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
