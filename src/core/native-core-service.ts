import path from "node:path";
import { nodeBindings } from "../control-plane/node-bindings.js";
import type { Api } from "grammy";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import {
  RailwayResourceGovernor,
  GrammyRichMessagePort,
  GrammyNativeMarkdownStreamPort,
  OpenCodeTopicWorker,
  TelegramNativeCore,
  type BindingIdentity,
  type RunIdentity,
  type WorkerFactory,
} from "@opencode-telegram/native-runtime";
import { config } from "../config.js";
import { opencodeClient } from "../opencode/client.js";
import { getRuntimePaths } from "../runtime/paths.js";
import { logger } from "../utils/logger.js";
import { resolveCatalogModel } from "../app/services/model-selection-service.js";
import { getTopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { createOpenCodeTemporarySessionPort } from "./opencode-session-port.js";
import type {
  CoreAbortTarget,
  CoreBindingOwner,
  CoreOwnedTaskContext,
  CoreTopicBindingInput,
} from "./types.js";

export type {
  CoreAbortTarget,
  CoreBindingOwner,
  CoreOwnedTaskContext,
  CoreTopicBindingInput,
} from "./types.js";

export interface CorePromptOptions {
  sessionID: string;
  directory: string;
  parts: Array<TextPartInput | FilePartInput>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
}

type PromptAsyncResult = Awaited<ReturnType<typeof opencodeClient.session.promptAsync>>;

const MiB = 1024 * 1024;
const PROMPT_DISPATCH_TIMEOUT_MS = 30_000;
const QUEUE_CANCELLATION_GRACE_MS = 2_000;
const WORKER_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_SERVICE_MEMORY_LIMIT_BYTES = 1024 * MiB;

function resolveServiceMemoryLimitBytes(): number {
  const cgroupLimit = RailwayResourceGovernor.serviceMemoryLimitBytes();
  if (cgroupLimit) return cgroupLimit;

  const configuredMb = Number.parseInt(process.env.BOT_PROCESS_MEMORY_LIMIT_MB ?? "", 10);
  if (Number.isSafeInteger(configuredMb) && configuredMb > 0) {
    return configuredMb * MiB;
  }
  return DEFAULT_SERVICE_MEMORY_LIMIT_BYTES;
}

function createRailwayResourcePolicy() {
  const limit = resolveServiceMemoryLimitBytes();
  return {
    softRssBytes: Math.floor(limit * 0.82),
    hardRssBytes: Math.floor(limit * 0.94),
    maxWorkers: 8,
    maxRestartsPerBinding: 3,
    restartWindowMs: 5 * 60_000,
  };
}

function resolveBotId(): string {
  const tokenPrefix = config.telegram.token.split(":", 1)[0]?.trim();
  if (!tokenPrefix || !/^\d+$/.test(tokenPrefix)) {
    throw new Error("Telegram bot token does not contain a valid numeric bot id");
  }
  return tokenPrefix;
}

function normalizeDirectory(directory: string): string {
  return path.resolve(directory);
}

export function coreBindingId(chatId: number, threadId: number): string {
  return `telegram:${resolveBotId()}:${chatId}:${threadId}`;
}

function toBindingIdentity(input: CoreTopicBindingInput, generation = 1): BindingIdentity {
  return {
    bindingId: coreBindingId(input.chatId, input.threadId),
    botId: resolveBotId(),
    chatId: input.chatId,
    threadId: input.threadId,
    sessionId: input.sessionId,
    normalizedDirectory: normalizeDirectory(input.directory),
    bindingGeneration: generation,
  };
}

async function promptAsyncWithModelRecovery(
  options: CorePromptOptions,
  signal: AbortSignal,
): Promise<PromptAsyncResult> {
  const requestOptions = { signal };
  const first = await opencodeClient.session.promptAsync(options, requestOptions);
  if (!first.error || !options.model) return first;

  const detail = String((first.error as { message?: string })?.message ?? first.error);
  const type = String((first.error as { name?: string })?.name ?? "");
  if (!/model\s+not\s+found|ProviderModelNotFoundError/i.test(`${type} ${detail}`)) {
    return first;
  }

  logger.warn(
    `[Core] Explicit model rejected; refreshing catalog: ${options.model.providerID}/${options.model.modelID}`,
  );
  const refreshed = await resolveCatalogModel(
    options.model.providerID,
    options.model.modelID,
    { forceRefresh: true },
  );
  if (refreshed) {
    const retry = await opencodeClient.session.promptAsync(
      {
        ...options,
        model: { providerID: refreshed.providerID, modelID: refreshed.modelID },
      },
      requestOptions,
    );
    if (!retry.error) return retry;
  }

  const fallback = { ...options };
  delete fallback.model;
  delete fallback.variant;
  return opencodeClient.session.promptAsync(fallback, requestOptions);
}

const temporarySessionPort = createOpenCodeTemporarySessionPort();
const workerFactory: WorkerFactory = (binding, generation) =>
  new OpenCodeTopicWorker(binding, generation, null, {
    promptTimeoutMs: PROMPT_DISPATCH_TIMEOUT_MS,
    cancellationGraceMs: QUEUE_CANCELLATION_GRACE_MS,
    stopTimeoutMs: WORKER_STOP_TIMEOUT_MS,
    abortSession: async (target, signal) => {
      // Confirmed infrastructure retirement already terminated this exact remote session.
      const retired=(await nodeBindings.list()).some(node=>node.sessionId===target.sessionId&&node.status==="retired");
      if(!retired)await temporarySessionPort.abort(target,signal);
    },
    temporarySessionPort,
    onIsolationFailure: (identity, error) => {
      logger.error(`[Core] Topic worker isolation failed: binding=${identity.bindingId}`, error);
    },
  });

let nativeCore: TelegramNativeCore | null = null;
const runsBySession = new Map<string, RunIdentity>();
let coreAdmissionTail: Promise<void> = Promise.resolve();

async function withCoreAdmissionLock<T>(task: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = coreAdmissionTail;
  coreAdmissionTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function requireCore(): TelegramNativeCore {
  if (!nativeCore) throw new Error("OpenCode Telegram Core is not initialized");
  return nativeCore;
}

export function getNativeCore(): TelegramNativeCore | null {
  return nativeCore;
}

export function resolveCoreSessionRoute(sessionId: string, directory?: string): BindingIdentity {
  const matches = requireCore().bindings.registry.list().filter((binding) =>
    binding.sessionId === sessionId &&
    (directory === undefined || binding.normalizedDirectory === normalizeDirectory(directory))
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Core Topic binding for session ${sessionId}; found ${matches.length}`);
  }
  return matches[0]!;
}

export function isCurrentCoreSessionRoute(route: BindingIdentity): boolean {
  return nativeCore?.bindings.registry.getExact(route) != null;
}

export function resolveCoreTopicBinding(chatId: number, threadId: number): BindingIdentity | null {
  if (!nativeCore || threadId <= 1) return null;
  return nativeCore.bindings.registry.getById(coreBindingId(chatId, threadId));
}

export async function resolveCoreEventRoute(sessionId: string | null, directory: string | null): Promise<BindingIdentity | null> {
  return nativeCore?.events.resolve(sessionId, directory ? normalizeDirectory(directory) : null) ?? null;
}

async function cleanupCoreBinding(api: Api, identity: BindingIdentity): Promise<void> {
  const { cleanupTelegramTopicBindingResources } = await import(
    "../app/services/telegram-topic-delete-service.js"
  );
  await cleanupTelegramTopicBindingResources(api, identity);
}

export async function initializeNativeCore(
  api: Api,
  bindings: readonly CoreTopicBindingInput[],
): Promise<void> {
  if (nativeCore) return;

  const bindingStorePath = path.join(
    getRuntimePaths().appHome,
    "runtime",
    "core",
    "bindings.json",
  );
  const railwayPolicy = createRailwayResourcePolicy();
  logger.info(
    `[Core] Railway memory policy: soft=${Math.round(railwayPolicy.softRssBytes / MiB)}MiB hard=${Math.round(railwayPolicy.hardRssBytes / MiB)}MiB maxWorkers=${railwayPolicy.maxWorkers}`,
  );
  const core = await TelegramNativeCore.open({
    bindingStorePath,
    workerFactory,

    outboundSink: {
      async send() {
        throw new Error("Core outbound sink is not used by the bot adapter");
      },
    },
    richMessagePort: new GrammyRichMessagePort(api),
    nativeMarkdownStreamPort: new GrammyNativeMarkdownStreamPort(api),
    abortRun: async (run) => {
      await opencodeClient.session.abort({
        sessionID: run.sessionId,
        directory: run.normalizedDirectory,
      });
    },
    cleanupBinding: (identity) => cleanupCoreBinding(api, identity),
    resolveSessionParent: async (sessionId, directory, signal) => {
      const { data, error } = await opencodeClient.session.get({ sessionID: sessionId, directory }, { signal });
      if (error || !data || data.id !== sessionId || normalizeDirectory(data.directory) !== directory) {
        throw new Error("OpenCode session ancestry lookup did not match its requested identity");
      }
      return data.parentID ?? null;
    },
    admissionPolicy: ({ route }) =>
      route.kind === "topic" && route.threadId > 1 ? "MODEL_ALLOWED" : "CONTROL_ONLY",
    railwayPolicy,
  });

  for (const binding of bindings) {
    const expected = toBindingIdentity(binding);
    const current = core.bindings.registry.getById(expected.bindingId);
    if (!current) {
      await core.registerBinding(expected);
      continue;
    }
    if (
      current.botId !== expected.botId ||
      current.chatId !== expected.chatId ||
      current.threadId !== expected.threadId ||
      current.sessionId !== expected.sessionId ||
      current.normalizedDirectory !== expected.normalizedDirectory
    ) {
      throw new Error(
        `Core binding drift detected for ${expected.bindingId}; refusing ambiguous startup`,
      );
    }
  }

  nativeCore = core;
  logger.info(
    `[Core] OpenCode Telegram Core initialized: bindings=${core.bindings.registry.list().length}, workers=${core.workers.size()}`,
  );
}

export async function shutdownNativeCore(): Promise<void> {
  const core = nativeCore;
  nativeCore = null;
  runsBySession.clear();
  if (core) await core.shutdown();
}

export async function registerCoreTopicBinding(input: CoreTopicBindingInput): Promise<void> {
  if (!nativeCore) return;
  const identity = toBindingIdentity(input);
  const existing = nativeCore.bindings.registry.getById(identity.bindingId);
  if (existing) {
    if (
      existing.sessionId === identity.sessionId &&
      existing.normalizedDirectory === identity.normalizedDirectory
    ) return;
    throw new Error(`Core binding already exists with different identity: ${identity.bindingId}`);
  }
  await nativeCore.registerBinding(identity);
}

export async function rotateCoreTopicBinding(
  input: CoreTopicBindingInput,
  next: { sessionId: string; directory: string },
): Promise<void> {
  if (!nativeCore) return;
  const bindingId = coreBindingId(input.chatId, input.threadId);
  const current = nativeCore.bindings.registry.getById(bindingId);
  if (!current) {
    await nativeCore.registerBinding(
      toBindingIdentity({ ...input, sessionId: next.sessionId, directory: next.directory }),
    );
    return;
  }
  if (
    current.sessionId !== input.sessionId ||
    current.normalizedDirectory !== normalizeDirectory(input.directory)
  ) {
    throw new Error(`Refusing stale Core binding rotation for ${bindingId}`);
  }
  if (
    current.sessionId === next.sessionId &&
    current.normalizedDirectory === normalizeDirectory(next.directory)
  ) return;
  await nativeCore.rotateBinding(bindingId, {
    sessionId: next.sessionId,
    normalizedDirectory: normalizeDirectory(next.directory),
  });
}

export function captureCurrentCoreBindingOwner(): CoreBindingOwner {
  const core = requireCore();
  const context = getTopicRuntimeContext();
  if (
    !context ||
    context.threadId <= 1 ||
    !context.sessionId ||
    !context.directory
  ) {
    throw new Error("Scheduled model execution requires an exact AI Topic binding");
  }

  const binding = core.bindings.registry.getById(
    coreBindingId(context.chatId, context.threadId),
  );
  if (
    !binding ||
    binding.sessionId !== context.sessionId ||
    binding.normalizedDirectory !== normalizeDirectory(context.directory)
  ) {
    throw new Error("Current Topic context does not match the authoritative Core binding");
  }

  return {
    bindingId: binding.bindingId,
    botId: binding.botId,
    chatId: binding.chatId,
    threadId: binding.threadId,
    sessionId: binding.sessionId,
    directory: binding.normalizedDirectory,
    bindingGeneration: binding.bindingGeneration,
  };
}

export async function beginCoreRunForOwner(
  owner: CoreBindingOwner,
  operation: string,
): Promise<RunIdentity> {
  return withCoreAdmissionLock(async () => {
    const core = requireCore();
    const current = core.bindings.registry.getById(owner.bindingId);
    if (
      !current ||
      current.botId !== owner.botId ||
      current.chatId !== owner.chatId ||
      current.threadId !== owner.threadId ||
      current.sessionId !== owner.sessionId ||
      current.normalizedDirectory !== normalizeDirectory(owner.directory) ||
      current.bindingGeneration !== owner.bindingGeneration
    ) {
      throw new Error(`Stale Core binding owner rejected: ${owner.bindingId}`);
    }

    const allowed = await core.modelAllowed(
      {
        kind: "topic",
        botId: current.botId,
        chatId: current.chatId,
        threadId: current.threadId,
      },
      operation,
    );
    if (!allowed) {
      throw new Error(`Core admission rejected model operation: ${operation}`);
    }

    return core.beginRun(current.bindingId);
  });
}

export async function beginCoreRunForSession(
  sessionId: string,
  directory: string,
  operation = "prompt",
  requireInteractiveTopic = true,
): Promise<RunIdentity> {
  return withCoreAdmissionLock(async () => {
    const core = requireCore();
    const normalized = normalizeDirectory(directory);
    const binding = resolveCoreSessionRoute(sessionId, normalized);

    if (requireInteractiveTopic) {
      const context = getTopicRuntimeContext();
      if (
        !context ||
        context.chatId !== binding.chatId ||
        context.threadId !== binding.threadId ||
        context.sessionId !== binding.sessionId ||
        !context.directory ||
        normalizeDirectory(context.directory) !== binding.normalizedDirectory
      ) {
        throw new Error("Interactive model execution is only allowed in the exact bound AI Topic");
      }
    }

    const allowed = await core.modelAllowed(
      { kind: "topic", botId: binding.botId, chatId: binding.chatId, threadId: binding.threadId },
      operation,
    );
    if (!allowed) throw new Error(`Core admission rejected model operation: ${operation}`);

    const previous = runsBySession.get(sessionId);
    if (previous) {
      if (core.runs.accepts(previous)) {
        throw new Error(`Core already owns an active run for session ${sessionId}`);
      }
      runsBySession.delete(sessionId);
    }
    if (core.runs.current(binding.bindingId)) {
      throw new Error(`Core binding already has an active run: ${binding.bindingId}`);
    }

    const run = await core.beginRun(binding.bindingId);
    runsBySession.set(sessionId, run);
    return run;
  });
}

export async function runCoreIdleMaintenance(
  reason: string,
  task: () => Promise<boolean>,
): Promise<boolean> {
  return withCoreAdmissionLock(async () => {
    const core = requireCore();
    const hasActiveRun = core.bindings.registry.list().some(
      (binding) => core.runs.current(binding.bindingId) != null,
    );
    if (hasActiveRun) return false;

    await core.workers.stopAll(`idle_maintenance:${reason}`);
    return task();
  });
}

export async function dispatchCorePrompt(
  run: RunIdentity,
  options: CorePromptOptions,
): Promise<PromptAsyncResult> {
  const core = requireCore();
  if (options.sessionID !== run.sessionId || normalizeDirectory(options.directory) !== run.normalizedDirectory) {
    throw new Error("prompt identity does not match the bound Topic");
  }
  const result = await core.dispatchTask(
    run,
    `prompt:${run.runId}`,
    ({ signal }) => promptAsyncWithModelRecovery(options, signal),
  );
  if ("error" in result && result.error) core.finishRun(run);
  return result;
}

export async function dispatchCoreOwnedTask<T>(
  run: RunIdentity,
  label: string,
  task: (context: CoreOwnedTaskContext) => Promise<T>,
  options: { abortTarget?: CoreAbortTarget | null; timeoutMs?: number } = {},
): Promise<T> {
  return requireCore().dispatchTask(run, label, task, options);
}

export async function runCoreSessionTask<T>(
  sessionId: string,
  directory: string,
  operation: string,
  task: (context: CoreOwnedTaskContext) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const run = await beginCoreRunForSession(sessionId, directory, operation);
  try {
    return await dispatchCoreOwnedTask(run, operation, task, options);
  } finally {
    finishCoreRunForSession(sessionId);
  }
}

export function finishCoreRun(run: RunIdentity): boolean {
  const core = nativeCore;
  if (!core) return false;
  return core.finishRun(run);
}

export function finishCoreRunForSession(sessionId: string): boolean {
  const core = nativeCore;
  const run = runsBySession.get(sessionId);
  if (!core || !run) return false;
  runsBySession.delete(sessionId);
  return finishCoreRun(run);
}

/** Restore only Control-side stream authority for an authenticated existing Worker run. No AI dispatch. */
export async function restoreRemoteCoreRun(sessionId:string,directory:string,externalRunId:string):Promise<RunIdentity> {
  return withCoreAdmissionLock(async()=>{
    const core=requireCore();
    const route=resolveCoreSessionRoute(sessionId,normalizeDirectory(directory));
    const topic=getTopicRuntimeContext();
    if(!topic||topic.chatId!==route.chatId||topic.threadId!==route.threadId||topic.sessionId!==sessionId||!topic.directory||normalizeDirectory(topic.directory)!==route.normalizedDirectory)throw new Error("Recovered Core run requires exact Topic context");
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(externalRunId))throw new Error("Invalid recovered run identity");
    const current=core.runs.current(route.bindingId);
    if(current){
      if(current.runId!==externalRunId)throw new Error("Recovered Worker run differs from current Core run");
      runsBySession.set(sessionId,current);return current;
    }
    if(!await core.modelAllowed({kind:"topic",botId:route.botId,chatId:route.chatId,threadId:route.threadId},"remote_recovery"))throw new Error("Recovered run Core admission rejected");
    const run=await core.beginRun(route.bindingId,externalRunId);runsBySession.set(sessionId,run);return run;
  });
}
