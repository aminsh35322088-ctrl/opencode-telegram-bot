import { createInfrastructureClient, InfrastructureRequestError } from "./railway-client.js";
import { lstat } from "node:fs/promises";
import { constants } from "node:os";
import {captureNodeRegistry} from "./node-registry.js";

// This process is the only infrastructure credential owner. Railway starts it as
// root; the existing bootstrap drops the Bot and Core to the node user. The
// credential never enters the shell, application, or runtime environment.
const nodes=captureNodeRegistry(process.env);
const infrastructure = createInfrastructureClient(process.env);
// Supplying the normal infrastructure credential enables safe cluster bootstrap.
// Only this boolean and non-secret configuration reach the application.
if(infrastructure.configured){
  process.env.CONTROL_INFRASTRUCTURE_ENABLED??="1";
  process.env.CONTROL_PROVISION_WORKERS_ENABLED??="1";
  process.env.CONTROL_CLUSTER_BOOTSTRAP_ENABLED??="1";
}

async function main(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("Infrastructure launcher requires a separate privileged identity");
  const { budgetedSpawn, budgetedExecFile } = await import("../runtime/process-budget.js");
  const volume = await lstat("/data");
  if (!volume.isDirectory() || volume.isSymbolicLink()) throw new Error("Invalid persistent volume root");
  // Only the mount root needs ownership preparation. Never traverse or execute
  // application-controlled persistent files as the credential-owning identity.
  const gatewayEnabled=nodes.metadata().length>0 || process.env.CONTROL_INFRASTRUCTURE_ENABLED==="1" || process.env.DISTRIBUTED_CONTROL_ENABLED==="1";
  if(gatewayEnabled){
    await budgetedExecFile("cleanup","/usr/bin/chown",["--no-dereference","0:0","/data"]);
    await budgetedExecFile("cleanup","/usr/bin/chmod",["1777","/data"]);
    const {mkdir,chmod}=await import("node:fs/promises");
    await mkdir("/data/.infrastructure",{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;});
    const directory=await lstat("/data/.infrastructure");
    if(!directory.isDirectory() || directory.isSymbolicLink() || directory.uid!==0)throw new Error("Invalid infrastructure state directory");
    await chmod("/data/.infrastructure",0o700);
    await nodes.load("/data/.infrastructure/nodes.json");
    await nodes.persist("/data/.infrastructure/nodes.json");
  }else{
    await budgetedExecFile("cleanup", "/usr/bin/chown", ["--no-dereference", "1000:1000", "/data"]);
  }
  const child = await budgetedSpawn("bot-daemon", "/app/railway-volume-maintenance.sh", [], {
    cwd: "/app",
    stdio: gatewayEnabled ? ["inherit","inherit","inherit","ipc"] : "inherit",
    env:{...process.env,...(gatewayEnabled?{CONTROL_APPLICATION_IPC:"1"}:{})},
    uid: 1000,
    gid: 1000,
  });
  process.stdout.write("[InfrastructureBoundary] startup_environment_isolated application_uid=node\n");
  let stopGateway:(()=>void)|undefined;
  if(gatewayEnabled){
    const {startNodeGateway}=await import("./node-gateway.js");
    const {NodeProtocol}=await import("../control-plane/node-protocol.js");
    const port=Number(process.env.PORT??8080);
    if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error("Invalid control gateway port");
    const {InfrastructureController}=await import("./node-controller.js");
    const {InfrastructureNodeTransport}=await import("./node-transport.js");
    const {getRuntimePaths}=await import("../runtime/paths.js");
    const pools=process.env.CONTROL_WORKER_POOLS?JSON.parse(process.env.CONTROL_WORKER_POOLS):undefined;
    const protocol=new NodeProtocol("/data/.infrastructure/replay.json");
    const retirementTransport=new InfrastructureNodeTransport(nodes,protocol,()=>nodes.persist("/data/.infrastructure/nodes.json"));
    const {WORKER_CORE_COMMIT}=await import("./worker-core-release.js");
    const controller=new InfrastructureController({coreCommit:WORKER_CORE_COMMIT,registry:nodes,stateDirectory:"/data/.infrastructure",bindingFilename:`${getRuntimePaths().appHome}/control-plane/node-bindings.json`,request:infrastructure.request,pools,controlUrl:process.env.CONTROL_PUBLIC_URL,retireNode:identity=>retirementTransport.retireFenced(identity)});
    stopGateway=startNodeGateway(child,nodes,protocol,port,controller);
    if(!pools && process.env.CONTROL_PROVISION_WORKERS_ENABLED==="1"){
      const poolConfiguration=(async()=>{let stage:'inventory'|'verify'='inventory';try{
        const {resolveWorkerPools}=await import("./worker-pools.js");
        const {resolveControlUrl}=await import("./control-location.js");
        const controlUrl=await resolveControlUrl({request:infrastructure.request,projectId:process.env.RAILWAY_PROJECT_ID??process.env.CONTROL_PROJECT_ID??"",environmentId:process.env.RAILWAY_ENVIRONMENT_ID??process.env.CONTROL_ENVIRONMENT_ID??"",serviceId:process.env.RAILWAY_SERVICE_ID??"",publicUrl:process.env.CONTROL_PUBLIC_URL});
        try{const contract=await infrastructure.request<{__type:{inputFields:Array<{name:string}>}}>('query WorkerVolumeContract{__type(name:"VolumeCreateInput"){inputFields{name}}}');
        process.stdout.write(`[InfrastructureBoundary] volume_create_fields=${contract.__type.inputFields.map(field=>field.name).filter(name=>/^[A-Za-z]+$/.test(name)).join(",")}\n`);}catch{process.stdout.write("[InfrastructureBoundary] volume_contract_unavailable\n");}
        const resolved=await resolveWorkerPools({request:infrastructure.request,workspaceId:process.env.CONTROL_WORKSPACE_ID||undefined,controlProjectId:process.env.RAILWAY_PROJECT_ID??process.env.CONTROL_PROJECT_ID??"",controlEnvironmentId:process.env.RAILWAY_ENVIRONMENT_ID??process.env.CONTROL_ENVIRONMENT_ID??"",workerProjectId:process.env.CONTROL_WORKER_A_PROJECT_ID||undefined,workerEnvironmentId:process.env.CONTROL_WORKER_A_ENVIRONMENT_ID||undefined,region:process.env.CONTROL_WORKER_REGION??"europe-west4-drams3a",onStage:value=>{stage=value;}});
        controller.configurePools(resolved,controlUrl);
        for(const pool of resolved)process.stdout.write(`[InfrastructureBoundary] worker_pool project=${pool.projectId} environment=${pool.environmentId} capacity=${pool.capacity}\n`);
      }catch(error){const classification=error instanceof InfrastructureRequestError?`${error.category} http=${error.status}`:'verification';process.stdout.write(`[InfrastructureBoundary] worker_pools_unavailable stage=${stage} category=${classification}\n`);throw error;}})();
      controller.waitForPoolConfiguration(poolConfiguration);
    }

    // Read plan metadata once per deployment; this is not a provisioning retry loop.
    const workspaceId=process.env.CONTROL_WORKSPACE_ID;
    if(workspaceId)void infrastructure.request<{workspace:{plan:string;projectCount:number}}>(
      "query InfrastructureWorkspace($workspaceId:String!){workspace(workspaceId:$workspaceId){plan projectCount}}",{workspaceId},
    ).then(({workspace})=>{
      if(/^[A-Z_]+$/.test(workspace.plan)&&Number.isSafeInteger(workspace.projectCount))process.stdout.write(`[InfrastructureBoundary] workspace_plan=${workspace.plan} projects=${workspace.projectCount}\n`);
    }).catch(()=>{process.stdout.write("[InfrastructureBoundary] workspace_metadata_unavailable\n");});
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => { child.kill(signal); });
  }
  child.once("error", () => {
    infrastructure.dispose();
    process.stderr.write("[InfrastructureBoundary] application_start_failed\n");
    process.exit(1);
  });
  child.once("close", (code, signal) => {
    stopGateway?.();nodes.dispose();
    infrastructure.dispose();
    process.exit(code ?? (signal ? 128 + constants.signals[signal] : 1));
  });
}

void main().catch(() => {
  infrastructure.dispose();
  process.stderr.write("[InfrastructureBoundary] launcher_failed\n");
  process.exit(1);
});
