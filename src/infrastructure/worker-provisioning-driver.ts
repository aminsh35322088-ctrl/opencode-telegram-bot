export interface WorkerPool { projectId: string; environmentId: string; capacity?: number; region: string }
export interface ProvisionedNode {
  slot?:number;clusterId?:string;unbound?:boolean;
  image?: string; runtimeCommit?:string; runtimeVersion?:string; volumeCreatePending?: boolean; everDeployed?:boolean;
  workerVariablesContract?: "identity-v1";
  nodeId: string; generation: number; projectId: string; environmentId: string;
  serviceId?: string; volumeId?: string; domainId?: string; endpoint?: string; deploymentId?: string;
  phase: "reserved" | "configured" | "deploying" | "retiring" | "retired";
}

/** Privileged provider boundary; topic/control code never sends GraphQL. */
export interface WorkerProvisioningDriver {
  listPools(): readonly WorkerPool[];
  listWorkers():Promise<ProvisionedNode[]>;
  inspectWorker(nodeId:string,generation:number):Promise<ProvisionedNode>;
  inspectCapacity(): Promise<Array<{pool:WorkerPool;used:number;available:number|null}>>;
  provision(nodeId:string,generation:number):Promise<ProvisionedNode>;
  retire(nodeId:string,generation:number):Promise<ProvisionedNode>;
  cleanupDeprecatedWorkerVariables(nodeId:string,generation:number,selftest:(nodeId:string,generation:number,profile:"baseline"|"browser"|"network")=>Promise<unknown>):Promise<void>;
}
export class WorkerProvisioningError extends Error {
 constructor(readonly category:"capacity_exhausted"|"project_unavailable"|"provisioning_pending"|"image_unavailable"|"reconciliation_required"|"image_mismatch") {super(category==="capacity_exhausted"?"NO WORKER AVAILABLE / CAPACITY EXHAUSTED":`Worker provisioning failed (${category})`);}
}
