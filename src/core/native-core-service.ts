import path from "node:path";
import type { Api } from "grammy";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import {
  SerialTaskQueue,
  TelegramNativeCore,
  sameBinding,
  sameRun,
  type BindingIdentity,
  type RunIdentity,
  type TopicWorker,
  type WorkerFactory,
} from "@opencode-telegram/native-runtime";
import { config } from "../config.js";
import { opencodeClient } from "../opencode/client.js";
import { getRuntimePaths } from "../runtime/paths.js";
import { logger } from "../utils/logger.js";
import { resolveCatalogModel } from "../app/services/model-selection-service.js";
import { getTopicRuntimeContext } from "../app/services/topic-runtime-context.js";

export interface CoreTopicBindingInput {
  chatId: number;
  threadId: number;
  sessionId: string;
  directory: string;
}

export interface CorePromptOptions {
  sessionID: string;
  directory: string;
  parts: Array<TextPartInput | FilePartInput>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
}

type PromptAsyncResult = Awaited<ReturnType<typeof opencodeClient.session.promptAsync>>;

const PROMPT_DISPATCH_TIMEOUT_MS = 30_000;
const QUEUE_CANCELLATION_GRACE_MS = 2_000;
const WORKER_STOP_TIMEOUT_MS = 5_000;

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

class BotTopicWorker implements TopicWorker {
  readonly bindingId: string;
  readonly generation: number;
  readonly #queue: SerialTaskQueue;
  #binding: BindingIdentity;
  #activeRun: RunIdentity | null = null;
  #stopController = new AbortController();
  #started = false;
  #stopped = false;

  constructor(binding: BindingIdentity, generation: number) {
    this.bindingId = binding.bindingId;
    this.generation = generation;
    this.#binding = binding;
    this.#queue = new SerialTaskQueue({
      defaultTimeoutMs: PROMPT_DISPATCH_TIMEOUT_MS,
      cancellationGraceMs: QUEUE_CANCELLATION_GRACE_MS,
      onUncooperativeTask: (error) => {
        logger.error(
          `[Core] Topic worker queue poisoned: binding=${this.bindingId}, generation=${this.generation}`,
          error,
        );
      },
    });
  }

  get idle(): boolean {
    return this.#started && !this.#stopped && this.#activeRun === null;
  }

  async start(binding: BindingIdentity): Promise<void> {
    if (binding.bindingId !== this.bindingId || !sameBinding(binding, this.#binding)) {
      throw new Error("worker start binding identity mismatch");
    }
    this.#binding = binding;
    this.#started = true;
  }

  async executeTask<T>(
    run: RunIdentity,
    label: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!this.#started || this.#stopped) throw new Error("topic worker is not active");
    if (run.bindingId !== this.bindingId || run.workerGeneration !== this.generation) {
      throw new Error("run does not belong to this topic worker");
    }
    if (!sameBinding(run, this.#binding)) {
      throw new Error("run binding identity does not match the worker lease");
    }
    if (this.#activeRun && !sameRun(this.#activeRun, run)) {
      throw new Error("topic worker already owns an active run");
    }
    this.#activeRun = run;
    try {
      return await this.#queue.enqueue(
        label,
        (queueSignal) => task(AbortSignal.any([queueSignal, this.#stopController.signal])),
      );
    } catch (error) {
      this.complete(run);
      throw error;
    }
  }

  async execute(run: RunIdentity, options: CorePromptOptions): Promise<PromptAsyncResult> {
    if (
      run.sessionId !== this.#binding.sessionId ||
      normalizeDirectory(options.directory) !== this.#binding.normalizedDirectory ||
      options.sessionID !== this.#binding.sessionId
    ) {
      throw new Error("prompt identity does not match the bound Topic");
    }
    const result = await this.executeTask(
      run,
      `prompt:${run.runId}`,
      (signal) => promptAsyncWithModelRecovery(options, signal),
    );
    if ("error" in result && result.error) this.complete(run);
    return result;
  }

  complete(run: RunIdentity): void {
    if (this.#activeRun && sameRun(this.#activeRun, run)) this.#activeRun = null;
  }

  async stop(reason: string): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    workersByLease.delete(workerLeaseKey(this.bindingId, this.generation));
    this.#stopController.abort(new Error(reason));
    const active = this.#activeRun;
    this.#activeRun = null;
    if (!active) return;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("worker stop timeout")),
      WORKER_STOP_TIMEOUT_MS,
    );
    try {
      await opencodeClient.session.abort(
        { sessionID: active.sessionId, directory: active.normalizedDirectory },
        { signal: controller.signal },
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.warn(
          `[Core] Failed to abort active session while stopping worker: binding=${this.bindingId}`,
          error,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

const workersByLease = new Map<string, BotTopicWorker>();

function workerLeaseKey(bindingId: string, generation: number): string {
  return `${bindingId}:${generation}`;
}

const workerFactory: WorkerFactory = (binding, generation) => {
  const worker = new BotTopicWorker(binding, generation);
  workersByLease.set(workerLeaseKey(binding.bindingId, generation), worker);
  return worker;
};

let nativeCore: TelegramNativeCore | null = null;
const runsBySession = new Map<string, RunIdentity>();

function requireCore(): TelegramNativeCore {
  if (!nativeCore) throw new Error("OpenCode Telegram Core is not initialized");
  return nativeCore;
}

export function getNativeCore(): TelegramNativeCore | null {
  return nativeCore;
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
  const core = await TelegramNativeCore.open({
    bindingStorePath,
    workerFactory,

    outboundSink: {
      async send() {
        throw new Error("Core outbound sink is not used by the bot adapter");
      },
    },
    richMessagePort: {
      async sendDraft() {
        throw new Error("Core rich draft port is not enabled in the bot adapter");
      },
      async sendFinal() {
        throw new Error("Core rich final port is not enabled in the bot adapter");
      },
    },
    nativeMarkdownStreamPort: {
      async streamMarkdown() {
        throw new Error("Core markdown stream port is not enabled in the bot adapter");
      },
    },
    abortRun: async (run) => {
      await opencodeClient.session.abort({
        sessionID: run.sessionId,
        directory: run.normalizedDirectory,
      });
    },
    cleanupBinding: (identity) => cleanupCoreBinding(api, identity),
    admissionPolicy: ({ route }) =>
      route.kind === "topic" && route.threadId > 1 ? "MODEL_ALLOWED" : "CONTROL_ONLY",
    railwayPolicy: {
      softRssBytes: 320 * 1024 * 1024,
      hardRssBytes: 448 * 1024 * 1024,
      maxWorkers: 8,
      maxRestartsPerBinding: 3,
      restartWindowMs: 5 * 60_000,
    },
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
  workersByLease.clear();
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

export async function beginCoreRunForSession(
  sessionId: string,
  directory: string,
  operation = "prompt",
  requireInteractiveTopic = true,
): Promise<RunIdentity> {
  const core = requireCore();
  const normalized = normalizeDirectory(directory);
  const binding = core.bindings.registry
    .list()
    .find(
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.normalizedDirectory === normalized,
    );
  if (!binding) throw new Error(`No Core Topic binding owns session ${sessionId}`);

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
}

export async function dispatchCorePrompt(
  run: RunIdentity,
  options: CorePromptOptions,
): Promise<PromptAsyncResult> {
  const core = requireCore();
  if (!core.runs.accepts(run)) throw new Error("Core run was fenced before prompt dispatch");
  const binding = core.bindings.registry.getExact(run);
  if (!binding) throw new Error("Core binding changed before prompt dispatch");
  const worker = await core.workers.ensure(binding);
  if (
    !(worker instanceof BotTopicWorker) ||
    worker.generation !== run.workerGeneration ||
    !core.workers.isCurrent(binding, worker)
  ) {
    throw new Error("Core worker changed before prompt dispatch");
  }
  return worker.execute(run, options);
}

function finishCoreRun(run: RunIdentity): boolean {
  const core = nativeCore;
  if (!core) return false;
  workersByLease.get(workerLeaseKey(run.bindingId, run.workerGeneration))?.complete(run);
  return core.finishRun(run);
}

export function finishCoreRunForSession(sessionId: string): boolean {
  const core = nativeCore;
  const run = runsBySession.get(sessionId);
  if (!core || !run) return false;
  runsBySession.delete(sessionId);
  return finishCoreRun(run);
}

export function getCoreRunForSession(sessionId: string): RunIdentity | null {
  return runsBySession.get(sessionId) ?? null;
}
