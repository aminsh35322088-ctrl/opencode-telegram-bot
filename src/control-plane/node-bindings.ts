import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getRuntimePaths } from "../runtime/paths.js";

export const MAX_AI_TOPICS = 4;
export interface NodeBinding {
  nodeId: string; chatId: number; threadId: number; generation: number;
  projectId?: string; serviceId?: string; volumeId?: string; endpoint?: string;
  currentRevision: number; status: "reserved" | "provisioning" | "ready" | "retiring" | "retired" | "failed";
  sessionId?: string; createdAt: string; updatedAt: string;
}
interface BindingState { version: 1; bindings: NodeBinding[] }
/** Single writer with persisted reservations. Failed/retiring reservations retain their slot until cleanup succeeds. */
export class NodeBindingStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly configuredFilename?:string) {}
  private get filename():string{return this.configuredFilename??path.join(getRuntimePaths().appHome,"control-plane","node-bindings.json");}
  private async read(): Promise<BindingState> {
    let raw: string;
    try { raw = await fs.readFile(this.filename, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, bindings: [] };
      throw error;
    }
    const state = JSON.parse(raw) as BindingState;
    if (state.version !== 1 || !Array.isArray(state.bindings)) throw new Error("Invalid node binding state");
    const nodes = new Set<string>(); const topics = new Set<string>();
    for (const binding of state.bindings) {
      if (!["reserved", "provisioning", "ready", "retiring", "retired", "failed"].includes(binding.status) || !Number.isSafeInteger(binding.currentRevision) || binding.currentRevision < 0 || !binding.nodeId || !Number.isSafeInteger(binding.generation) || binding.generation < 1 || !Number.isSafeInteger(binding.chatId) || !Number.isSafeInteger(binding.threadId) || binding.threadId < 1) throw new Error("Invalid node identity");
      if (nodes.has(binding.nodeId)) throw new Error("Duplicate node identity");
      nodes.add(binding.nodeId);
      if (binding.status !== "retired") {
        const topic = `${binding.chatId}:${binding.threadId}`;
        if (topics.has(topic)) throw new Error("Duplicate active topic binding");
        topics.add(topic);
      }
    }
    if (topics.size > MAX_AI_TOPICS) throw new Error("Node capacity exceeded in persisted state");
    return state;
  }
  private transaction<T>(change: (state: BindingState) => T | Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const state = await this.read(); const result = await change(state);
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.filename);
      const directory = await fs.open(path.dirname(this.filename), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return structuredClone(result);
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  async list(): Promise<NodeBinding[]> { await this.queue; return structuredClone((await this.read()).bindings); }
  async find(chatId: number, threadId: number): Promise<NodeBinding | undefined> {
    return (await this.list()).find((binding) => binding.chatId === chatId && binding.threadId === threadId && binding.status !== "retired");
  }
  reserve(chatId: number, threadId: number): Promise<NodeBinding> {
    return this.transaction((state) => {
      if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(threadId) || threadId < 1) throw new Error("AI node requires a Telegram Topic");
      const existing = state.bindings.find((binding) => binding.chatId === chatId && binding.threadId === threadId && binding.status !== "retired");
      if (existing) return existing;
      if (state.bindings.filter((binding) => binding.status !== "retired").length >= MAX_AI_TOPICS) throw new Error("Maximum four AI Topics reached");
      const now = new Date().toISOString();
      const binding: NodeBinding = { nodeId: randomUUID(), chatId, threadId, generation: 1, currentRevision: 0, status: "reserved", createdAt: now, updatedAt: now };
      state.bindings.push(binding); return binding;
    });
  }
  update(nodeId: string, generation: number, patch: Partial<Pick<NodeBinding, "projectId" | "serviceId" | "volumeId" | "endpoint" | "currentRevision" | "status" | "sessionId">>): Promise<NodeBinding> {
    return this.transaction((state) => {
      const binding = state.bindings.find((item) => item.nodeId === nodeId);
      if (!binding || binding.generation !== generation || binding.status === "retired") throw new Error("Stale node generation");
      if (patch.currentRevision !== undefined && patch.currentRevision < binding.currentRevision) throw new Error("Global revision cannot regress");
      if (patch.endpoint && (new URL(patch.endpoint).protocol !== "https:" || new URL(patch.endpoint).username || new URL(patch.endpoint).password)) throw new Error("Node transport requires HTTPS");
      if (patch.status === "ready" && !(patch.endpoint ?? binding.endpoint)) throw new Error("Ready node requires endpoint");
      Object.assign(binding, patch, { updatedAt: new Date().toISOString() }); return binding;
    });
  }
  /** Fence immediately, before aborting/retiring remote resources. Slot remains occupied until confirmed cleanup. */
  fence(nodeId: string, generation: number): Promise<NodeBinding> {
    return this.transaction((state) => {
      const binding = state.bindings.find((item) => item.nodeId === nodeId);
      if (!binding) throw new Error("Unknown node");
      if (binding.generation === generation + 1 && binding.status === "retiring") return binding;
      if (binding.generation !== generation || binding.status === "retired") throw new Error("Stale node generation");
      binding.generation++; binding.status = "retiring"; binding.updatedAt = new Date().toISOString(); return binding;
    });
  }
}
export const nodeBindings = new NodeBindingStore();
