import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { getRuntimePaths } from "../runtime/paths.js";
import { syncDirectory } from "../utils/sync-directory.js";
import { runInTopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { TopicNodeClient } from "./topic-node-client.js";
import {
  RunRegistry,
  SerialTaskQueue,
  pollRunResult,
  sameBinding,
  type BindingIdentity,
  type RunIdentity,
} from "@opencode-telegram/native-runtime";
import { nodeBindings, type NodeBinding } from "./node-bindings.js";
import type { CoreAbortTarget, CoreOwnedTaskContext } from "../core/types.js";

/** Bot-side identity/correlation only. Inference and execution stay on the signed Worker RPC boundary. */
export class RemoteTopicAuthority {
  private readonly routes = new Map<string, BindingIdentity>();
  private readonly owners = new Map<string, Pick<NodeBinding, "nodeId" | "generation">>();
  private registrationTail: Promise<unknown> = Promise.resolve();
  private readonly uncertainWorkers = new Map<string, number>();
  private workerKey(node: Pick<NodeBinding, "nodeId" | "generation">): string {
    return `${node.nodeId}:${node.generation}`;
  }
  private async durableGeneration(input: BindingIdentity, node: NodeBinding): Promise<number> {
    const filename = path.join(getRuntimePaths().appHome, "control-plane", "topic-authority.json");
    type Entry = { identity: BindingIdentity; nodeId: string; nodeGeneration: number };
    let entries: Entry[] = [];
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(filename, "utf8"));
      if (
        !Array.isArray(parsed) ||
        parsed.some(
          (entry) =>
            !entry?.identity ||
            typeof entry.nodeId !== "string" ||
            !Number.isSafeInteger(entry.nodeGeneration) ||
            !Number.isSafeInteger(entry.identity.bindingGeneration) ||
            entry.identity.bindingGeneration < 1,
        )
      )
        throw new Error("Invalid remote Topic authority store");
      entries = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const previous = entries.find((entry) => entry.identity.bindingId === input.bindingId);
    if (
      previous &&
      sameBinding(
        { ...input, bindingGeneration: previous.identity.bindingGeneration },
        previous.identity,
      ) &&
      previous.nodeId === node.nodeId &&
      previous.nodeGeneration === node.generation
    )
      return previous.identity.bindingGeneration;
    const generation = Math.max(node.generation, (previous?.identity.bindingGeneration ?? 0) + 1);
    if (!Number.isSafeInteger(generation)) throw new Error("Remote Topic generation exhausted");
    entries = entries.filter((entry) => entry.identity.bindingId !== input.bindingId);
    entries.push({
      identity: { ...input, bindingGeneration: generation },
      nodeId: node.nodeId,
      nodeGeneration: node.generation,
    });
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(entries));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, filename);
      await syncDirectory(path.dirname(filename));
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return generation;
  }
  private readonly queues = new Map<string, SerialTaskQueue>();
  readonly runs = new RunRegistry();
  readonly bindings = {
    registry: {
      list: () => [...this.routes.values()],
      getById: (id: string) => this.routes.get(id) ?? null,
      getExact: (identity: BindingIdentity) => {
        const current = this.routes.get(identity.bindingId);
        return current && sameBinding(current, identity) ? current : null;
      },
    },
  };
  readonly events = {
    resolve: async (sessionId: string | null, directory: string | null) => {
      const matches = [...this.routes.values()].filter(
        (route) =>
          route.sessionId === sessionId &&
          (!directory || route.normalizedDirectory === path.resolve(directory)),
      );
      if (matches.length !== 1) return null;
      try {
        await this.assertNode(matches[0]!);
        return matches[0]!;
      } catch {
        return null;
      }
    },
  };

  private async readyNode(identity: BindingIdentity): Promise<NodeBinding> {
    const node = await nodeBindings.find(identity.chatId, identity.threadId);
    if (!node || node.status !== "ready" || node.sessionId !== identity.sessionId)
      throw new Error("Remote Topic lacks a ready Worker owner");
    return node;
  }
  async registerBinding(input: BindingIdentity, rotating = false): Promise<void> {
    const operation = this.registrationTail
      .catch(() => {})
      .then(() => this.registerSerialized(input, rotating));
    this.registrationTail = operation;
    return operation;
  }
  private async registerSerialized(input: BindingIdentity, rotating: boolean): Promise<void> {
    const node = await this.readyNode(input);
    const current = this.routes.get(input.bindingId);
    const owner = this.owners.get(input.bindingId);
    if (
      current &&
      !rotating &&
      (current.sessionId !== input.sessionId ||
        current.normalizedDirectory !== input.normalizedDirectory)
    )
      throw new Error("Remote binding identity requires explicit rotation");
    if (
      current &&
      sameBinding({ ...input, bindingGeneration: current.bindingGeneration }, current) &&
      owner?.nodeId === node.nodeId &&
      owner.generation === node.generation
    )
      return;
    this.revoke(input.bindingId);
    const generation = await this.durableGeneration(input, node);
    this.routes.set(input.bindingId, Object.freeze({ ...input, bindingGeneration: generation }));
    this.owners.set(input.bindingId, { nodeId: node.nodeId, generation: node.generation });
    this.queues.set(
      input.bindingId,
      new SerialTaskQueue({ defaultTimeoutMs: 30_000, cancellationGraceMs: 2_000 }),
    );
  }
  async refresh(input: BindingIdentity): Promise<boolean> {
    try {
      await this.registerBinding(input);
      return true;
    } catch {
      this.revoke(input.bindingId);
      return false;
    }
  }
  async rotateBinding(
    id: string,
    next: { sessionId: string; normalizedDirectory: string },
  ): Promise<void> {
    const current = this.routes.get(id);
    if (!current) throw new Error("Remote Topic binding missing during rotation");
    await this.registerBinding({ ...current, ...next }, true);
  }
  revoke(id: string): void {
    this.runs.fence(id);
    this.routes.delete(id);
    this.owners.delete(id);
  }
  revokeSession(chatId: number, sessionId: string): void {
    for (const route of this.routes.values())
      if (route.chatId === chatId && route.sessionId === sessionId) this.revoke(route.bindingId);
  }
  async assertNode(identity: BindingIdentity): Promise<NodeBinding> {
    if (!this.bindings.registry.getExact(identity))
      throw new Error("Remote Topic binding changed or was fenced");
    const node = await this.readyNode(identity);
    if (!this.bindings.registry.getExact(identity))
      throw new Error("Remote Topic binding changed during owner lookup");
    const owner = this.owners.get(identity.bindingId);
    if (owner?.nodeId !== node.nodeId || owner.generation !== node.generation)
      throw new Error("Remote Worker generation changed");
    return node;
  }
  async modelAllowed(
    route: { kind: string; botId: string; chatId: number; threadId: number },
    _operation: string,
  ): Promise<boolean> {
    const identity = [...this.routes.values()].find(
      (item) =>
        item.botId === route.botId &&
        item.chatId === route.chatId &&
        item.threadId === route.threadId,
    );
    if (route.kind !== "topic" || route.threadId <= 1 || !identity) return false;
    const node = await this.assertNode(identity);
    if (this.queues.get(identity.bindingId)?.poisoned)
      throw new Error("Remote control task cleanup is uncertain");
    const key = this.workerKey(node);
    const uncertainSince = this.uncertainWorkers.get(key);
    if (uncertainSince !== undefined) {
      // A prepare receipt can reserve its run for 30s without a native execution.
      // After that window, only a fresh signed idle result may lift uncertainty.
      if (Date.now() - uncertainSince < 30_000)
        throw new Error("Remote control task cleanup is uncertain");
      const client = new TopicNodeClient(node, async () => {
        await this.assertNode(identity);
      });
      const status = await client.request("status", {}, { signal: AbortSignal.timeout(5_000) });
      const proof = status as { continuation?: unknown; externalRunId?: unknown } | null;
      if (
        !proof ||
        proof.continuation !== "idle" ||
        proof.externalRunId !== null ||
        this.queues.get(identity.bindingId)?.poisoned ||
        this.uncertainWorkers.get(key) !== uncertainSince
      )
        throw new Error("Remote control task cleanup is uncertain");
      this.uncertainWorkers.delete(key);
    }
    return true;
  }
  async beginRun(id: string, externalRunId?: string): Promise<RunIdentity> {
    const identity = this.routes.get(id);
    if (!identity) throw new Error("Remote Topic binding missing");
    const node = await this.assertNode(identity);
    return this.runs.startExclusive(identity, node.generation, externalRunId);
  }
  finishRun(run: RunIdentity): boolean {
    return this.runs.finish(run);
  }
  async dispatchTask<T>(
    run: RunIdentity,
    label: string,
    task: (context: CoreOwnedTaskContext) => Promise<T>,
    options: { abortTarget?: CoreAbortTarget | null; timeoutMs?: number } = {},
  ): Promise<T> {
    const check = async () => {
      if (!this.runs.accepts(run)) throw new Error("Remote run was fenced before task dispatch");
      await this.assertNode(run);
    };
    await check();
    const capturedNode = await this.assertNode(run);
    const queue = this.queues.get(run.bindingId)!;
    try {
      return await queue.enqueue(
        label,
        async (signal) => {
          const checkpoint = async () => {
            signal.throwIfAborted();
            await check();
          };
          await checkpoint();
          const result = await runInTopicRuntimeContext(
            {
              chatId: run.chatId,
              threadId: run.threadId,
              sessionId: run.sessionId,
              directory: run.normalizedDirectory,
            },
            () =>
              task({
                signal,
                checkpoint,
                setAbortTarget: (target) => {
                  if (
                    target &&
                    (target.sessionId !== run.sessionId ||
                      path.resolve(target.directory) !== run.normalizedDirectory)
                  )
                    throw new Error("Remote task abort target differs from owned session");
                },
                withTemporarySession: async () => {
                  throw new Error("Remote temporary sessions must be owned by Worker Core");
                },
                poll: (read, pollOptions) =>
                  pollRunResult(run, read, {
                    ...pollOptions,
                    signal,
                    checkpoint,
                    isCurrent: (candidate) =>
                      this.runs.accepts(candidate) && !!this.bindings.registry.getExact(candidate),
                  }),
              }),
          );
          await checkpoint();
          return result;
        },
        options.timeoutMs,
      );
    } catch (error) {
      // Cancellation of the control request does not prove the Worker stopped its model task.
      try {
        const client = new TopicNodeClient(capturedNode, async () => {
          await this.assertNode(run);
        });
        const result = await client.request(
          "stop",
          { runId: run.runId },
          { signal: AbortSignal.timeout(5_000) },
        );
        if (result !== true && result !== null) throw new Error("Remote stop was not confirmed");
      } catch {
        this.uncertainWorkers.set(this.workerKey(capturedNode), Date.now());
      }
      if (queue.poisoned) this.uncertainWorkers.set(this.workerKey(capturedNode), Date.now());
      throw error;
    }
  }
  shutdown(): void {
    for (const id of this.routes.keys()) this.revoke(id);
  }
}
