import { createInfrastructureClient } from "./railway-client.js";
import { lstat } from "node:fs/promises";
import { constants } from "node:os";
import {captureNodeRegistry} from "./node-registry.js";

// This process is the only infrastructure credential owner. Railway starts it as
// root; the existing bootstrap drops the Bot and Core to the node user. The
// credential never enters the shell, application, or runtime environment.
const nodes=captureNodeRegistry(process.env);
const infrastructure = createInfrastructureClient(process.env);

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
    const controller=new InfrastructureController({registry:nodes,stateDirectory:"/data/.infrastructure",bindingFilename:`${getRuntimePaths().appHome}/control-plane/node-bindings.json`,request:infrastructure.request,pools,controlUrl:process.env.CONTROL_PUBLIC_URL,retireNode:identity=>retirementTransport.retireFenced(identity)});
    stopGateway=startNodeGateway(child,nodes,protocol,port,controller);
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
