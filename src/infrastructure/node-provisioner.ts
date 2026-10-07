import { WORKER_CORE_COMMIT } from "./worker-core-release.js";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { NodeBinding } from "../control-plane/node-bindings.js";

export interface WorkerPool { projectId: string; environmentId: string; capacity: 2; region: string }
export interface ProvisionedNode {
  slot?:number;clusterId?:string;unbound?:boolean;
  workerVariablesContract?: "identity-v1";
  nodeId: string; generation: number; projectId: string; environmentId: string;
  serviceId?: string; volumeId?: string; domainId?: string; endpoint?: string; deploymentId?: string;
  phase: "reserved" | "configured" | "deploying" | "retiring" | "retired";
}
interface Journal { version: 1; nodes: ProvisionedNode[] }
interface Edge<T> { edges: Array<{ node: T }>; pageInfo: { hasNextPage: boolean } }
interface VolumeInstance { environmentId: string; serviceId: string | null; volumeId: string; sizeMB: number; mountPath: string; isPendingDeletion: boolean }
interface Inventory {
  project: { id: string; services: Edge<{ id: string; name: string }>; volumes: Edge<{ id: string; volumeInstances: Edge<VolumeInstance> }> };
  environment: { id: string; projectId: string; serviceInstances: Edge<{serviceId: string; domains: {serviceDomains: Array<{id: string; domain: string}>}; latestDeployment: {id: string} | null}> };
}
export interface NodeProvisionerOptions {
  request<T>(document: string, variables: Record<string, unknown>): Promise<T>;
  pools: [WorkerPool, WorkerPool]; coreCommit?:string; controlUrl: string; journalPath: string;
  /** Canonical persisted binding resolver; caller supplied objects alone cannot authorize infrastructure. */
  lookup(nodeId: string): Promise<NodeBinding | undefined>;
  /** Root-private durable identity store. The returned key must never be sent to the Bot/model process. */
  ensureIdentity(binding: Readonly<NodeBinding>, createSecret: () => string): Promise<string>;
  retireIdentity(nodeId: string, generation: number): Promise<void>;
  /** Bounded active provisioning delay; never used as an idle reconciliation loop. */
  wait?(milliseconds:number):Promise<void>;
  /** Fixed stage names and resource metadata only; never variables or credentials. */
  onStage?(stage:string):void;
  onInventory?(inventory:Inventory):void;
  /** Install the root-private transport identity before the Worker can call back during startup. */
  configured?(binding: Readonly<NodeBinding>, node: Readonly<ProvisionedNode>): Promise<void>;
}
const INVENTORY = `query WorkerInventory($projectId:String!,$environmentId:String!){ project(id:$projectId){id services(first:100){pageInfo{hasNextPage} edges{node{id name}}} volumes(first:100){pageInfo{hasNextPage} edges{node{id volumeInstances(first:100){pageInfo{hasNextPage} edges{node{environmentId serviceId volumeId sizeMB mountPath isPendingDeletion}}}}}}} environment(id:$environmentId){id projectId serviceInstances(first:100){pageInfo{hasNextPage} edges{node{serviceId domains{serviceDomains{id domain}} latestDeployment{id}}}}}}`;

/** Root-owned request-driven controller: no background loop and no arbitrary GraphQL interface. */
export class NodeProvisioner {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: NodeProvisionerOptions) {
    if (!/^[a-f0-9]{40}$/.test(options.coreCommit ?? WORKER_CORE_COMMIT)) throw new Error("Worker Core source must be an exact commit");
    const control = new URL(options.controlUrl);
    if (control.protocol !== "https:" || !control.hostname.endsWith(".up.railway.app") || control.username || control.password || control.search || control.hash || control.pathname !== "/") throw new Error("Control URL must be a Railway HTTPS domain");
    if (options.pools[0].capacity !== 2 || options.pools[1].capacity !== 2 || options.pools[0].projectId === options.pools[1].projectId) throw new Error("Worker pools require two distinct two-slot projects");
  }
  private async read(): Promise<Journal> {
    try {
      const journal = JSON.parse(await readFile(this.options.journalPath, "utf8")) as Journal;
      if (journal.version !== 1 || !Array.isArray(journal.nodes) || journal.nodes.length > 1000) throw new Error("Invalid infrastructure journal");
      const ids = new Set<string>();
      for (const item of journal.nodes) {
        if (ids.has(item.nodeId) || !Number.isSafeInteger(item.generation) || item.generation < 1 || !this.options.pools.some(pool => pool.projectId === item.projectId && pool.environmentId === item.environmentId)) throw new Error("Invalid infrastructure ownership");
        ids.add(item.nodeId);
      }
      return journal;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nodes: [] }; throw error; }
  }
  private async save(journal: Journal): Promise<void> {
    await mkdir(path.dirname(this.options.journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.journalPath}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(journal)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.options.journalPath);
    const directory = await open(path.dirname(this.options.journalPath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private singleFlight<T>(task: () => Promise<T>): Promise<T> {
    const current = this.queue.then(task); this.queue = current.catch(() => undefined); return current;
  }
  private async binding(nodeId: string, generation: number): Promise<NodeBinding> {
    const binding = await this.options.lookup(nodeId);
    if (!binding || binding.nodeId !== nodeId || binding.generation !== generation || (binding.threadId <= 1 && !(binding.chatId===0 && binding.threadId===0 && binding.slot && ["pool-reserved","pool-provisioning","available","retiring"].includes(binding.status))) || !Number.isSafeInteger(binding.chatId) || binding.status === "retired") throw new Error("Infrastructure node authorization failed");
    return binding;
  }
  /** Root-owned maintenance only; deliberately absent from application IPC and generic operations. */
  cleanupDeprecatedWorkerVariables(nodeId: string, generation: number, selftest: (nodeId: string, generation: number, profile: "baseline" | "browser" | "network") => Promise<unknown>): Promise<void> {
    return this.singleFlight(async () => {
      try {
        const stat = await lstat(this.options.journalPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024) throw new Error("Invalid journal");
        const journal = await this.read();
        const record = journal.nodes.find(node => node.nodeId === nodeId && node.generation === generation);
        if (!record || !record.unbound || record.slot !== 1 || record.phase !== "deploying" || !record.serviceId || !record.volumeId) throw new Error("Invalid Worker ownership");
        const pool = this.options.pools.find(item => item.projectId === record.projectId && item.environmentId === record.environmentId)!;
        const fence = async () => {
          const binding = await this.binding(nodeId, generation);
          if (binding.status !== "available" || binding.chatId !== 0 || binding.threadId !== 0 || binding.sessionId !== undefined || binding.slot !== record.slot || binding.clusterId !== record.clusterId || binding.projectId !== record.projectId || binding.serviceId !== record.serviceId || binding.volumeId !== record.volumeId) throw new Error("Canonical Worker fence changed");
          const inventory = await this.inventory(pool);
          const services = inventory.project.services.edges.filter(({node}) => node.id === record.serviceId || node.name === `topic-node-${nodeId}`);
          const volumes = inventory.project.volumes.edges.filter(({node}) => node.id === record.volumeId || node.volumeInstances.edges.some(({node: instance}) => instance.serviceId === record.serviceId));
          if (services.length !== 1 || services[0]!.node.id !== record.serviceId || services[0]!.node.name !== `topic-node-${nodeId}` || !inventory.environment.serviceInstances.edges.some(({node}) => node.serviceId === record.serviceId) || volumes.length !== 1 || volumes[0]!.node.id !== record.volumeId || volumes[0]!.node.volumeInstances.edges.length !== 1) throw new Error("Worker inventory changed");
          const volume = volumes[0]!.node.volumeInstances.edges[0]!.node;
          if (volume.volumeId !== record.volumeId || volume.serviceId !== record.serviceId || volume.environmentId !== record.environmentId || volume.mountPath !== "/data" || volume.sizeMB !== 500 || volume.isPendingDeletion) throw new Error("Worker Volume ownership changed");
          const current = await this.binding(nodeId, generation);
          if (current.status !== "available" || current.chatId !== 0 || current.threadId !== 0 || current.sessionId !== undefined || current.slot !== record.slot || current.clusterId !== record.clusterId || current.projectId !== record.projectId || current.serviceId !== record.serviceId || current.volumeId !== record.volumeId) throw new Error("Canonical Worker fence changed");
        };
        await fence();
        for (const profile of ["baseline", "browser", "network"] as const) {
          const result = await selftest(nodeId, generation, profile) as {profile?:unknown;joined?:unknown;success?:unknown;runId?:unknown};
          if (!result || result.profile !== profile || result.joined !== true || result.success !== true || typeof result.runId !== "string" || !/^[a-f0-9]{48}$/.test(result.runId)) throw new Error("Worker canary failed");
          await fence();
        }
        if (record.workerVariablesContract !== undefined && record.workerVariablesContract !== "identity-v1") throw new Error("Invalid cleanup receipt");
        if (record.workerVariablesContract === "identity-v1") return;
        const binding = await this.binding(nodeId, generation);
        const secret = await this.options.ensureIdentity(binding, () => { throw new Error("Worker seed missing"); });
        if (typeof secret !== "string" || secret.length < 48) throw new Error("Worker seed missing");
        await fence();
        // A lost response retries this identical atomic write; no per-name deletions or deployment.
        const result = await this.options.request<{variableCollectionUpsert:boolean}>("mutation WorkerVariableCleanup($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}", {input:{projectId:record.projectId,environmentId:record.environmentId,serviceId:record.serviceId,replace:true,skipDeploys:true,variables:{NODE_ID:nodeId,NODE_SHARED_SECRET:secret,NODE_GENERATION:String(generation),CONTROL_PLANE_URL:this.options.controlUrl}}});
        if (result?.variableCollectionUpsert !== true) throw new Error("Worker variable replacement rejected");
        await fence();
        record.workerVariablesContract = "identity-v1";
        await this.save(journal);
      } catch { throw new Error("Worker variable cleanup failed"); }
    });
  }
  private async mutate(document: string, variables: Record<string, unknown>): Promise<void> {
    const stage=/^mutation ([A-Za-z]+)\(/.exec(document)?.[1];
    if(stage)this.options.onStage?.(stage);
    const result = await this.options.request<Record<string, unknown>>(document, variables);
    if (!result || Object.values(result).some(value => value === false || value === null)) throw new Error("Railway resource mutation was rejected");
  }
  private async inventory(pool: WorkerPool): Promise<Inventory> {
    this.options.onStage?.("WorkerInventory");
    const inventory = await this.options.request<Inventory>(INVENTORY, { projectId: pool.projectId, environmentId: pool.environmentId });
    if (inventory.project.id !== pool.projectId || inventory.environment.id !== pool.environmentId || inventory.environment.projectId !== pool.projectId || inventory.project.services.pageInfo.hasNextPage || inventory.project.volumes.pageInfo.hasNextPage || inventory.environment.serviceInstances.pageInfo.hasNextPage || inventory.project.volumes.edges.some(volume => volume.node.volumeInstances.pageInfo.hasNextPage)) throw new Error("Incomplete infrastructure inventory");
    this.options.onInventory?.(inventory);
    return inventory;
  }
  provision(nodeId: string, generation: number): Promise<ProvisionedNode> {
    return this.singleFlight(async () => {
      const binding = await this.binding(nodeId, generation);
      if (!['reserved', 'provisioning', 'failed', 'ready','pool-reserved','pool-provisioning','available'].includes(binding.status)) throw new Error("Node is being retired");
      const journal = await this.read();
      let record = journal.nodes.find(item => item.nodeId === nodeId);
      if(record && record.unbound && binding.threadId>1 && generation===record.generation+1){
        record.generation=generation;record.unbound=false;record.phase="reserved";await this.save(journal);
      }
      if (record && (record.generation !== generation || record.phase === "retired" || record.phase === "retiring")) throw new Error("Infrastructure generation already fenced");
      if (!record) {
        if (journal.nodes.filter(item => item.phase !== "retired").length >= 4) throw new Error("Maximum four AI nodes reached");
        const preferred=binding.slot?this.options.pools[binding.slot<=2?0:1]:undefined;
        const pool = this.options.pools.find(candidate => (!preferred||candidate===preferred) && journal.nodes.filter(item => item.projectId === candidate.projectId && item.phase !== "retired").length < candidate.capacity);
        if (!pool) throw new Error("No free worker pool slot");
        record = { nodeId, generation, slot:binding.slot,clusterId:binding.clusterId,unbound:binding.chatId===0&&binding.threadId===0, projectId: pool.projectId, environmentId: pool.environmentId, phase: "reserved" };
        journal.nodes.push(record); await this.save(journal);
      }
      const pool = this.options.pools.find(candidate => candidate.projectId === record.projectId)!;
      let inventory = await this.inventory(pool);
      const serviceName = `topic-node-${nodeId}`;
      const candidates = inventory.project.services.edges.filter(entry => entry.node.name === serviceName);
      if (candidates.length > 1) throw new Error("Ambiguous node service ownership");
      if (record.serviceId && !candidates.some(entry => entry.node.id === record!.serviceId)) throw new Error("Node service ownership mismatch");
      if (!record.serviceId) {
        record.serviceId = candidates[0]?.node.id;
        if (!record.serviceId) {
          // An ambiguous create is never blindly retried: next invocation reconciles the fixed name first.
          this.options.onStage?.("WorkerServiceCreate");
          const created = await this.options.request<{serviceCreate: {id: string}}>(`mutation WorkerService($input:ServiceCreateInput!){serviceCreate(input:$input){id}}`, {input:{projectId:pool.projectId,environmentId:pool.environmentId,name:serviceName}});
          record.serviceId = created.serviceCreate.id;
        }
        await this.save(journal);
      }
      await this.mutate(`mutation WorkerLimits($input:ServiceInstanceLimitsUpdateInput!){serviceInstanceLimitsUpdate(input:$input)}`, {input:{environmentId:pool.environmentId,serviceId:record.serviceId,memoryGB:1,vCPUs:2}});
      inventory = await this.inventory(pool);
      const instances = inventory.project.volumes.edges.flatMap(entry => entry.node.volumeInstances.edges.map(instance => instance.node)).filter(instance => instance.environmentId === pool.environmentId && instance.serviceId === record!.serviceId);
      if (instances.length > 1) throw new Error("Worker must have exactly one volume");
      // Existing attached volumes retain their region; discovery defaults must never move their service.
      await this.mutate(`mutation WorkerConfig($environmentId:String!,$serviceId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(environmentId:$environmentId,serviceId:$serviceId,input:$input)}`, {environmentId:pool.environmentId,serviceId:record.serviceId,input:{dockerfilePath:"Dockerfile.worker",numReplicas:1,sleepApplication:true,healthcheckPath:"/health",healthcheckTimeout:300,...(instances.length===0?{multiRegionConfig:{[pool.region]:{numReplicas:1}}}:{}),tracingEnabled:false,autoInstrumentationEnabled:false,restartPolicyType:"ON_FAILURE",restartPolicyMaxRetries:3}});
      if(record.volumeId){
        const volume=inventory.project.volumes.edges.find(entry=>entry.node.id===record!.volumeId)?.node;
        if(!volume||volume.volumeInstances.edges.some(entry=>entry.node.serviceId!==null && entry.node.serviceId!==record!.serviceId))throw new Error("Node volume ownership mismatch");
      }
      if (!record.volumeId) {
        record.volumeId = instances[0]?.volumeId;
        if (!record.volumeId) {
          // Bare records and historical instances are not assumed to consume the
          // active quota. Let Railway classify actual account/resource limits.
          this.options.onStage?.("WorkerVolumeCreate");
          const volume = await this.options.request<{volumeCreate:{id:string}}>(`mutation WorkerVolume($input:VolumeCreateInput!){volumeCreate(input:$input){id}}`, {input:{projectId:pool.projectId,environmentId:null,serviceId:null,mountPath:"/data"}});
          record.volumeId = volume.volumeCreate.id;
        }
        await this.save(journal);
      }
      if(!instances.some(instance=>instance.volumeId===record!.volumeId)){
        // Create a bare project record first; size and mount are applied atomically.
        // This follows Railway CLI EnvironmentConfig VolumeInstance/VolumeMount contracts.
        await this.mutate(`mutation WorkerVolumeAttach($environmentId:String!,$patch:EnvironmentConfig!){environmentPatchCommit(environmentId:$environmentId,patch:$patch,commitMessage:"Provision dedicated 500MB Topic volume")}`,{environmentId:pool.environmentId,patch:{volumes:{[record.volumeId!]:{isCreated:true,sizeMB:500,region:pool.region}},services:{[record.serviceId!]:{volumeMounts:{[record.volumeId!]:{mountPath:"/data"}}}}}});
      }
      // Environment patches may apply asynchronously. Only inventory reads are retried:
      // never submit another create/attach while the original patch is in flight.
      let verifiedVolume=false;
      for(let attempt=0;attempt<5;attempt++){
        inventory = await this.inventory(pool);
        const attached = inventory.project.volumes.edges.flatMap(entry => entry.node.volumeInstances.edges.map(instance => instance.node)).filter(instance => instance.environmentId === pool.environmentId && instance.serviceId === record!.serviceId);
        if(attached.length>1||attached.some(instance=>instance.volumeId!==record!.volumeId||instance.isPendingDeletion))throw new Error("Worker volume ownership changed during provisioning");
        if(attached.length===1 && attached[0]!.sizeMB===500 && attached[0]!.mountPath==="/data"){verifiedVolume=true;break;}
        if(attached.length===1)throw new Error("Worker volume is not verified dedicated 500MB storage");
        if(attempt<4)await (this.options.wait??(milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))))(Math.min(1000*2**attempt,8000));
        await this.binding(nodeId,generation);
      }
      if(!verifiedVolume)throw new Error("Worker volume activation pending; retry reconciliation");
      if (record.phase === "deploying" && record.endpoint) {
        const knownDomains = inventory.environment.serviceInstances.edges.find(entry => entry.node.serviceId === record!.serviceId)?.node.domains.serviceDomains ?? [];
        if (knownDomains.length !== 1 || `https://${knownDomains[0]?.domain}` !== record.endpoint || knownDomains[0]?.id !== record.domainId) throw new Error("Worker domain ownership mismatch");
        record.deploymentId = inventory.environment.serviceInstances.edges.find(entry => entry.node.serviceId === record!.serviceId)?.node.latestDeployment?.id;
        await this.save(journal); await this.binding(nodeId,generation); return structuredClone(record);
      }
      await this.binding(nodeId,generation);
      const secret = await this.options.ensureIdentity(binding, () => randomBytes(48).toString("base64url"));
      if (secret.length < 48) throw new Error("Node identity secret insufficient");
      await this.mutate(`mutation WorkerVariables($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}`, {input:{projectId:pool.projectId,environmentId:pool.environmentId,serviceId:record.serviceId,replace:true,skipDeploys:true,variables:{NODE_ID:nodeId,NODE_GENERATION:String(generation),NODE_SHARED_SECRET:secret,CONTROL_PLANE_URL:this.options.controlUrl}}});
      const serviceInstance = inventory.environment.serviceInstances.edges.find(entry => entry.node.serviceId === record!.serviceId)?.node;
      const domains = serviceInstance?.domains.serviceDomains ?? [];
      if (domains.length > 1) throw new Error("Ambiguous worker public domains");
      if (!record.endpoint) {
        const domain = domains[0] ?? (await this.options.request<{serviceDomainCreate:{id:string;domain:string}}>(`mutation WorkerDomain($input:ServiceDomainCreateInput!){serviceDomainCreate(input:$input){id domain}}`, {input:{environmentId:pool.environmentId,serviceId:record.serviceId,targetPort:8080}})).serviceDomainCreate;
        if (!domain.domain.endsWith(".up.railway.app")) throw new Error("Unexpected worker domain");
        record.domainId = domain.id; record.endpoint = `https://${domain.domain}`; await this.save(journal);
      }
      record.phase = "configured"; await this.save(journal);
      await this.options.configured?.(binding,record);
      // Source is connected only after limits, persistent storage, identity and the narrow domain are configured.
      await this.binding(nodeId,generation);
      const coreCommit=this.options.coreCommit??WORKER_CORE_COMMIT;
      if(!/^[a-f0-9]{40}$/.test(coreCommit))throw new Error("Worker Core source must be an exact commit");
      await this.mutate(`mutation WorkerSource($environmentId:String!,$patch:EnvironmentConfig!){environmentPatchCommit(environmentId:$environmentId,patch:$patch,commitMessage:"Deploy exact Worker Core build")}`, {environmentId:pool.environmentId,patch:{services:{[record.serviceId!]:{source:{repo:"aminsh35322088-ctrl/opencode-telegram-core",branch:"main",commitSha:coreCommit}}}}});
      record.phase = "deploying"; await this.save(journal);
      inventory = await this.inventory(pool);
      record.deploymentId = inventory.environment.serviceInstances.edges.find(entry => entry.node.serviceId === record!.serviceId)?.node.latestDeployment?.id;
      await this.save(journal);
      await this.binding(nodeId,generation);
      return structuredClone(record);
    });
  }
  retire(nodeId: string, generation: number): Promise<ProvisionedNode> {
    return this.singleFlight(async () => {
      const binding = await this.binding(nodeId,generation);
      if (binding.status !== "retiring") throw new Error("Retirement requires fenced canonical binding");
      const journal = await this.read(); const record = journal.nodes.find(item => item.nodeId === nodeId);
      if (!record || record.generation !== generation - 1) throw new Error("Retirement ownership mismatch");
      if (record.phase === "retired") return structuredClone(record);
      record.phase = "retiring"; await this.save(journal);
      await this.options.retireIdentity(nodeId,generation);
      const pool = this.options.pools.find(candidate => candidate.projectId === record.projectId)!;
      const inventory = await this.inventory(pool);
      const serviceName=`topic-node-${nodeId}`;
      const matches=inventory.project.services.edges.filter(entry=>entry.node.name===serviceName);
      if(matches.length>1)throw new Error("Ambiguous retirement service ownership");
      const ownedService = record.serviceId ? inventory.project.services.edges.find(entry => entry.node.id === record.serviceId)?.node : matches[0]?.node;
      if (ownedService && ownedService.name !== `topic-node-${nodeId}`) throw new Error("Retirement service ownership mismatch");
      if(ownedService && !record.serviceId){record.serviceId=ownedService.id;await this.save(journal);}
      const attachedVolumes=inventory.project.volumes.edges.filter(entry=>entry.node.volumeInstances.edges.some(instance=>instance.node.environmentId===pool.environmentId&&instance.node.serviceId===record.serviceId));
      if(attachedVolumes.length>1)throw new Error("Ambiguous retirement volume ownership");
      if(!record.volumeId && attachedVolumes[0]){record.volumeId=attachedVolumes[0].node.id;await this.save(journal);}
      if (ownedService) await this.mutate(`mutation RetireService($id:String!,$environmentId:String!){serviceDelete(id:$id,environmentId:$environmentId)}`,{id:record.serviceId,environmentId:pool.environmentId});
      const ownedVolume = inventory.project.volumes.edges.find(entry => entry.node.id === record.volumeId)?.node;
      if (ownedVolume) {
        if (ownedVolume.volumeInstances.edges.some(entry => entry.node.serviceId && entry.node.serviceId !== record.serviceId)) throw new Error("Retirement volume ownership mismatch");
        await this.mutate(`mutation RetireVolume($volumeId:String!){volumeDelete(volumeId:$volumeId)}`,{volumeId:record.volumeId});
      }
      record.phase = "retired"; await this.save(journal); return structuredClone(record);
    });
  }
}
