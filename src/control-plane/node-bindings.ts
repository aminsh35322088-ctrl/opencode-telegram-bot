import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getRuntimePaths } from "../runtime/paths.js";

export interface NodeBinding {
  slot?: number; clusterId?: string;
  nodeId: string; chatId: number; threadId: number; generation: number;
  projectId?: string; serviceId?: string; volumeId?: string; endpoint?: string;
  currentRevision: number; status: "reserved" | "provisioning" | "ready" | "retiring" | "retired" | "failed" | "pool-reserved" | "pool-provisioning" | "available";
  sessionId?: string; createdAt: string; updatedAt: string;
}
interface TopicCreation {key:string;chatId:number;directory:string;threadId?:number;cleaning?:boolean;failed?:boolean;nodeId?:string;generation?:number;completed?:boolean}
interface BindingState { version: 1; clusterId?: string; bindings: NodeBinding[]; creations?:TopicCreation[] }
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
    if(state.creations!==undefined){
      if(!Array.isArray(state.creations))throw new Error("Invalid Topic creation receipts");
      const keys=new Set<string>();
      for(const o of state.creations){
        const key=`${o.chatId}:${o.key}`;
        if(!o||typeof o.key!=="string"||!o.key||o.key.length>128||!Number.isSafeInteger(o.chatId)||o.chatId===0||typeof o.directory!=="string"||!o.directory||keys.has(key)||o.threadId!==undefined&&(!Number.isSafeInteger(o.threadId)||o.threadId<=1)||[o.completed,o.cleaning,o.failed].some(v=>v!==undefined&&typeof v!=="boolean")||o.completed&&(!o.threadId||!o.nodeId||!Number.isSafeInteger(o.generation)||o.generation!<1))throw new Error("Invalid Topic creation receipt");
        keys.add(key);
      }
    }
    const nodes = new Set<string>(); const topics = new Set<string>(); const slots=new Set<number>();
    for (const binding of state.bindings) {
      if (!["reserved", "provisioning", "ready", "retiring", "retired", "failed", "pool-reserved", "pool-provisioning", "available"].includes(binding.status) || !Number.isSafeInteger(binding.currentRevision) || binding.currentRevision < 0 || !binding.nodeId || !Number.isSafeInteger(binding.generation) || binding.generation < 1 || !Number.isSafeInteger(binding.chatId) || !Number.isSafeInteger(binding.threadId) || (binding.chatId===0&&(binding.threadId!==0||binding.sessionId!==undefined)) || (binding.threadId <= 1 && !(binding.chatId===0 && binding.threadId===0 && binding.slot && ["pool-reserved","pool-provisioning","available","retiring","retired"].includes(binding.status)))) throw new Error("Invalid node identity");
      if (nodes.has(binding.nodeId)) throw new Error("Duplicate node identity");
      nodes.add(binding.nodeId);
      if (binding.status !== "retired") {
        if(binding.slot!==undefined){if(!Number.isInteger(binding.slot)||binding.slot<1||slots.has(binding.slot)||binding.clusterId!==state.clusterId)throw new Error("Invalid cluster slot ownership");slots.add(binding.slot);}
        if(binding.chatId===0 && binding.threadId===0)continue;
        const topic = `${binding.chatId}:${binding.threadId}`;
        if (topics.has(topic)) throw new Error("Duplicate active topic binding");
        topics.add(topic);
      }
    }
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
    if(threadId<=1)return undefined;
    return (await this.list()).find((binding) => binding.chatId === chatId && binding.threadId === threadId && binding.status !== "retired");
  }
  /** Reconcile persisted Workers; optional explicit warm capacity, never a fixed topology. */
  ensurePoolSlots(warmCapacity=0):Promise<NodeBinding[]>{
    if(!Number.isSafeInteger(warmCapacity)||warmCapacity<0||warmCapacity>1000)throw new Error("Invalid warm Worker policy");
    return this.transaction(state=>{
      state.clusterId??=randomUUID();
      for(let slot=1;slot<=warmCapacity;slot++){
        if(state.bindings.some(binding=>binding.slot===slot && binding.status!=="retired"))continue;
        const now=new Date().toISOString();
        state.bindings.push({nodeId:randomUUID(),clusterId:state.clusterId,slot,generation:1,chatId:0,threadId:0,currentRevision:0,status:"pool-reserved",createdAt:now,updatedAt:now});
      }
      return state.bindings.filter(binding=>binding.status!=="retired").sort((a,b)=>a.slot!-b.slot!);
    });
  }
  reserve(chatId: number, threadId: number): Promise<NodeBinding> {
    return this.transaction((state) => {
      if (chatId===0 || !Number.isSafeInteger(chatId) || !Number.isSafeInteger(threadId) || threadId <= 1) throw new Error("AI node requires a Telegram Topic");
      const existing = state.bindings.find((binding) => binding.chatId === chatId && binding.threadId === threadId && binding.status !== "retired");
      if (existing) return existing;
      if(state.clusterId){
        const available=state.bindings.find(binding=>binding.status==="available" && binding.chatId===0 && binding.threadId===0);
        if(available){available.generation++;available.chatId=chatId;available.threadId=threadId;available.status="reserved";available.updatedAt=new Date().toISOString();return available;}
      }
      const now = new Date().toISOString();
      const binding: NodeBinding = { nodeId: randomUUID(), chatId, threadId, generation: 1, currentRevision: 0, status: "reserved", createdAt: now, updatedAt: now };
      state.bindings.push(binding); return binding;
    });
  }
  /** Durable Telegram create receipt: unknown external results are never blindly replayed. */
  beginCreation(key:string,chatId:number,directory:string):Promise<{fresh:boolean;operation:TopicCreation}>{
    return this.transaction(state=>{
      if(!key||key.length>128||!Number.isSafeInteger(chatId)||chatId===0||!directory)throw new Error("Invalid Topic creation identity");
      state.creations??=[];
      const existing=state.creations.find(o=>o.key===key&&o.chatId===chatId);
      if(existing)return {fresh:false,operation:existing};
      const operation={key,chatId,directory};state.creations.push(operation);return {fresh:true,operation};
    });
  }
  recordCreation(key:string,chatId:number,patch:{threadId?:number;cleaning?:boolean;failed?:boolean;nodeId?:string;generation?:number;completed?:boolean}):Promise<void>{
    return this.transaction(state=>{
      const operation=state.creations?.find(o=>o.key===key&&o.chatId===chatId);
      if(!operation||patch.threadId!==undefined&&(!Number.isSafeInteger(patch.threadId)||patch.threadId<=1||operation.threadId!==undefined&&operation.threadId!==patch.threadId))throw new Error("Topic creation receipt mismatch");
      if(operation.completed&&(patch.nodeId!==undefined&&patch.nodeId!==operation.nodeId||patch.generation!==undefined&&patch.generation!==operation.generation||patch.completed===false)||operation.cleaning&&patch.cleaning===false||operation.failed&&patch.failed===false)throw new Error("Topic creation receipt already fenced");
      if(patch.completed&&(!(patch.nodeId??operation.nodeId)||!Number.isSafeInteger(patch.generation??operation.generation)||(patch.generation??operation.generation)!<1||!(patch.threadId??operation.threadId)))throw new Error("Incomplete Topic creation receipt");
      Object.assign(operation,patch);
    });
  }
  update(nodeId: string, generation: number, patch: Partial<Pick<NodeBinding, "projectId" | "serviceId" | "volumeId" | "endpoint" | "currentRevision" | "status" | "sessionId">>): Promise<NodeBinding> {
    return this.transaction((state) => {
      const binding = state.bindings.find((item) => item.nodeId === nodeId);
      if (!binding || binding.generation !== generation || binding.status === "retired") throw new Error("Stale node generation");
      if (patch.currentRevision !== undefined && patch.currentRevision < binding.currentRevision) throw new Error("Global revision cannot regress");
      if (patch.endpoint && (new URL(patch.endpoint).protocol !== "https:" || new URL(patch.endpoint).username || new URL(patch.endpoint).password)) throw new Error("Node transport requires HTTPS");
      if (patch.status === "available" && (binding.chatId!==0||binding.threadId!==0||!binding.slot||!(patch.endpoint??binding.endpoint)))throw new Error("Available Worker requires unbound slot and endpoint");
      if(binding.chatId===0&&binding.threadId===0&&patch.sessionId!==undefined)throw new Error("Unbound Worker cannot own a session");
      if(patch.status==="ready"&&(binding.chatId===0||binding.threadId<=1))throw new Error("Ready Worker requires a bound Telegram Topic");
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
