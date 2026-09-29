import { resetAllStreamThrottles, resetStreamThrottle } from "../../bot/streaming/stream-throttle.js";
import { getTopicRuntimeContext } from "../services/topic-runtime-context.js";
import { logger } from "../../utils/logger.js";
import { finishCoreRunForSession } from "../../core/native-core-service.js";

export interface AssistantRunStartInfo {
  startedAt: number;
  configuredAgent?: string | undefined;
  configuredProviderID?: string | undefined;
  configuredModelID?: string | undefined;
}

export interface AssistantRunResolvedInfo {
  agent?: string | undefined;
  providerID?: string | undefined;
  modelID?: string | undefined;
}

export interface AssistantRunInfo extends AssistantRunStartInfo {
  sessionId: string;
  generation: number;
  runId: string;
  actualAgent?: string | undefined;
  actualProviderID?: string | undefined;
  actualModelID?: string | undefined;
  hasCompletedResponse: boolean;
}

class AssistantRunState {
  private readonly runs = new Map<string, AssistantRunInfo>();
  private readonly generations = new Map<string, number>();

  startRun(sessionId: string, info: AssistantRunStartInfo, coreRunId?: string): void {
    if (!sessionId) return;
    resetStreamThrottle(sessionId);
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    const runId = coreRunId ?? `${sessionId}:${generation}:${info.startedAt}`;
    this.runs.set(sessionId, { sessionId, generation, runId, startedAt: info.startedAt, configuredAgent: info.configuredAgent, configuredProviderID: info.configuredProviderID, configuredModelID: info.configuredModelID, hasCompletedResponse: false });
    logger.debug(`[AssistantRunState] Started run: session=${sessionId}, generation=${generation}, runId=${runId}, agent=${info.configuredAgent || "unknown"}, model=${info.configuredProviderID || "unknown"}/${info.configuredModelID || "unknown"}`);
  }

  private getScopedSessionId(): string | undefined { return getTopicRuntimeContext()?.sessionId; }

  hasActiveRuns(): boolean {
    const sessionId = this.getScopedSessionId();
    return sessionId ? this.hasActiveRun(sessionId) : Array.from(this.runs.values()).some((run) => !run.hasCompletedResponse);
  }

  hasActiveRun(sessionId: string): boolean {
    if (!sessionId) return false;
    // A run remains active until OpenCode emits session.idle (or an explicit
    // error/abort clears it). The assistant response can become terminal before
    // the final Telegram/tool streams are flushed, so completion alone must not
    // invalidate the run guards used by those finalization paths.
    return this.runs.has(sessionId);
  }

  getRun(sessionId: string): AssistantRunInfo | null { const run = this.runs.get(sessionId); return run ? { ...run } : null; }

  getRunGeneration(sessionId: string): number | null {
    return this.runs.get(sessionId)?.generation ?? null;
  }

  markResponseCompleted(sessionId: string, info?: AssistantRunResolvedInfo): void {
    const run = this.runs.get(sessionId);
    if (!run) return;
    run.hasCompletedResponse = true;
    if (info?.agent) run.actualAgent = info.agent;
    if (info?.providerID) run.actualProviderID = info.providerID;
    if (info?.modelID) run.actualModelID = info.modelID;
    logger.debug(`[AssistantRunState] Response completed: session=${sessionId}`);
  }

  finishRun(sessionId: string, reason: string): AssistantRunInfo | null {
    resetStreamThrottle(sessionId);
    const run = this.runs.get(sessionId) ?? null;
    if (!run) return null;
    this.runs.delete(sessionId);
    finishCoreRunForSession(sessionId);
    logger.debug(`[AssistantRunState] Finished run: session=${sessionId}, reason=${reason}`);
    return { ...run };
  }

  clearRun(sessionId: string, reason: string): void {
    resetStreamThrottle(sessionId);
    if (!this.runs.delete(sessionId)) return;
    finishCoreRunForSession(sessionId);
    logger.debug(`[AssistantRunState] Cleared run: session=${sessionId}, reason=${reason}`);
  }

  clearAll(reason: string): void {
    resetAllStreamThrottles();
    if (this.runs.size === 0) return;
    logger.debug(`[AssistantRunState] Cleared all runs: count=${this.runs.size}, reason=${reason}`);
    for (const sessionId of this.runs.keys()) finishCoreRunForSession(sessionId);
    this.runs.clear();
  }

  __resetForTests(): void {
    resetAllStreamThrottles();
    this.runs.clear();
    this.generations.clear();
  }
}

export const assistantRunState = new AssistantRunState();
