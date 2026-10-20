export interface WorkerPool { projectId: string; environmentId: string; capacity?: number; region: string }

/**
 * Last-resort single-project fallback used only after Railway rejects creating
 * another managed Worker project because of a resource quota. The live service
 * and journal counts remain the baseline; Railway still validates every mutation.
 */
export function nextCapacityAfterProjectQuota(
  configuredCapacity: number | undefined,
  journalWorkers: number,
  liveServices: number,
): number | undefined {
  for (const [name, value] of [["journalWorkers", journalWorkers], ["liveServices", liveServices]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Worker pool inventory: ${name}`);
  }
  if (configuredCapacity !== undefined && (!Number.isSafeInteger(configuredCapacity) || configuredCapacity < 0)) {
    throw new Error("Invalid configured Worker pool capacity");
  }
  if (configuredCapacity === undefined) return undefined;
  const baseline = Math.max(journalWorkers, liveServices);
  if (baseline < configuredCapacity) return undefined;
  return baseline + 1;
}
export interface ProvisionedNode {
  slot?:number;clusterId?:string;unbound?:boolean;
  image?: string; runtimeCommit?:string; runtimeVersion?:string; imageUpdated?:boolean; sleepApplication?:boolean; sleepPolicyUpdated?:boolean; deploymentStatus?:string; volumeCreatePending?: boolean; everDeployed?:boolean;
  workerVariablesContract?: "identity-v1";
  nodeId: string; generation: number; projectId: string; environmentId: string;
  serviceId?: string; volumeId?: string; domainId?: string; endpoint?: string; deploymentId?: string;
  phase: "reserved" | "configured" | "deploying" | "recycled" | "retiring" | "retired";
}

/** Privileged provider boundary; topic/control code never sends GraphQL. */
export interface WorkerProvisioningDriver {
  discardDeletedProjects(projectIds:readonly string[]):Promise<ProvisionedNode[]>;
  bootstrapInventory():Promise<{projectCount:number;workers:ProvisionedNode[]}>;
  listPools(): readonly WorkerPool[];
  listWorkers():Promise<ProvisionedNode[]>;
  inspectWorker(nodeId:string,generation:number):Promise<ProvisionedNode>;
  inspectCapacity(): Promise<Array<{pool:WorkerPool;used:number;available:number|null}>>;
  setPoolCapacity(capacity:number): void;
  provision(nodeId:string,generation:number):Promise<ProvisionedNode>;
  handoff(nodeId:string,generation:number):Promise<ProvisionedNode>;
  retire(nodeId:string,generation:number):Promise<ProvisionedNode>;
  cleanupDeprecatedWorkerVariables(nodeId:string,generation:number,selftest:(nodeId:string,generation:number,profile:"baseline"|"browser"|"network")=>Promise<unknown>):Promise<void>;
}
export class WorkerProvisioningError extends Error {
 constructor(readonly category:"capacity_exhausted"|"project_unavailable"|"provisioning_pending"|"image_unavailable"|"reconciliation_required"|"image_mismatch") {super(category==="capacity_exhausted"?"NO WORKER AVAILABLE / CAPACITY EXHAUSTED":`Worker provisioning failed (${category})`);}
}
