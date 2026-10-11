import {WORKER_RUNTIME_IMAGE} from "./worker-core-release.js";
import { createInfrastructureClient, InfrastructureRequestError } from "./railway-client.js";
import { lstat } from "node:fs/promises";
import { constants } from "node:os";
import {captureNodeRegistry} from "./node-registry.js";
import {resolveControlRuntimeConfig,configureApplicationEnvironment} from "./control-runtime-config.js";

// This process is the only infrastructure credential owner. Railway starts it as
// root; the existing bootstrap drops the Bot and Core to the node user. The
// credential never enters Worker variables, model state or application storage.
const nodes=captureNodeRegistry(process.env);
const infrastructure = createInfrastructureClient(process.env);
const existingVariableNames=Object.keys(process.env);
const workerImage=process.env.WORKER_RUNTIME_IMAGE??WORKER_RUNTIME_IMAGE;
const poolPolicy=process.env.WORKER_POOL_POLICY?JSON.parse(process.env.WORKER_POOL_POLICY):undefined;
delete process.env.WORKER_RUNTIME_IMAGE;delete process.env.WORKER_POOL_POLICY;
const runtimeConfig=resolveControlRuntimeConfig(process.env,infrastructure.configured,nodes.metadata().length>0);
configureApplicationEnvironment(process.env,runtimeConfig);

async function main(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("Infrastructure launcher requires a separate privileged identity");
  const { budgetedSpawn, budgetedExecFile } = await import("../runtime/process-budget.js");
  const volume = await lstat("/data");
  if (!volume.isDirectory() || volume.isSymbolicLink()) throw new Error("Invalid persistent volume root");
  const gatewayEnabled=runtimeConfig.gatewayEnabled;
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

  let stopGateway:(()=>void)|undefined;
  let gatewayStart:((child:import("node:child_process").ChildProcess)=>void)|undefined;
  if(gatewayEnabled){
    const {startNodeGateway}=await import("./node-gateway.js");
    const {NodeProtocol}=await import("../control-plane/node-protocol.js");
    const {InfrastructureController}=await import("./node-controller.js");
    const {InfrastructureNodeTransport}=await import("./node-transport.js");
    const {getRuntimePaths}=await import("../runtime/paths.js");
    const {resolveWorkerPools,createWorkerPool}=await import("./worker-pools.js");
    const {resolveControlUrl}=await import("./control-location.js");
    const {RailwayCredentialStore}=await import("./railway-credential-store.js");
    const {RailwayOnboardingController}=await import("./railway-onboarding-controller.js");
    const {validateRailwayInfrastructureCredential}=await import("./railway-credential-validation.js");
    const port=Number(process.env.PORT??8080);
    if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error("Invalid control gateway port");
    const protocol=new NodeProtocol("/data/.infrastructure/replay.json");
    const retirementTransport=new InfrastructureNodeTransport(nodes,protocol,()=>nodes.persist("/data/.infrastructure/nodes.json"));
    const {WORKER_CORE_COMMIT}=await import("./worker-core-release.js");
    const controller=new InfrastructureController({coreCommit:WORKER_CORE_COMMIT,workerImage,registry:nodes,stateDirectory:"/data/.infrastructure",bindingFilename:`${getRuntimePaths().appHome}/control-plane/node-bindings.json`,request:infrastructure.request,retireNode:identity=>retirementTransport.retireFenced(identity),probeUnbound:(nodeId,generation)=>retirementTransport.probeUnboundBoundary(nodeId,generation),onClusterVerified:async()=>{
      if(!infrastructure.configured)return;
      try{
        const {cleanupDeprecatedControlVariables}=await import("./control-variable-cleanup.js");
        await cleanupDeprecatedControlVariables({request:infrastructure.request,projectId:runtimeConfig.projectId,environmentId:runtimeConfig.environmentId,serviceId:runtimeConfig.serviceId,names:existingVariableNames});
        process.stdout.write("[InfrastructureBoundary] control_variables_reconciled contract=secrets-and-user-settings\n");
      }catch{process.stdout.write("[InfrastructureBoundary] control_variable_cleanup_pending\n");}
      try{
        const {verifyWorkerRuntimeCanary}=await import("./worker-runtime-canary.js");
        void verifyWorkerRuntimeCanary({journalPath:"/data/.infrastructure/provisioning.json",selftest:(nodeId,generation,profile)=>retirementTransport.runtimeSelftest(nodeId,generation,profile),log:message=>{process.stdout.write(message);},afterVerified:async(nodeId,generation)=>{
          await controller.cleanupRuntimeCanaryVariables(nodeId,generation,(id,epoch,profile)=>retirementTransport.runtimeSelftest(id,epoch,profile));
          process.stdout.write(`[InfrastructureBoundary] worker_variables_reconciled node=${nodeId} generation=${generation} contract=identity-v1 restartVerification=pending\n`);
        }}).catch(()=>{process.stdout.write("[InfrastructureBoundary] worker_runtime_canary_pending\n");});
      }catch{process.stdout.write("[InfrastructureBoundary] worker_runtime_canary_pending\n");}
    }});

    let configuredWorkspaceId:string|undefined;
    let poolConfigured=false;
    const configureWorkspace=async(workspaceId:string):Promise<void>=>{
      if(poolConfigured){
        if(configuredWorkspaceId!==workspaceId)throw new Error("Railway workspace is already active");
        return;
      }
      let stage:'inventory'|'verify'='inventory';
      try{
        const controlUrl=await resolveControlUrl({request:infrastructure.request,projectId:runtimeConfig.projectId,environmentId:runtimeConfig.environmentId,serviceId:runtimeConfig.serviceId});
        try{const contract=await infrastructure.request<{__type:{inputFields:Array<{name:string}>}}>('query WorkerVolumeContract{__type(name:"VolumeCreateInput"){inputFields{name}}}');
          process.stdout.write(`[InfrastructureBoundary] volume_create_fields=${contract.__type.inputFields.map(field=>field.name).filter(name=>/^[A-Za-z]+$/.test(name)).join(",")}\n`);
        }catch{process.stdout.write("[InfrastructureBoundary] volume_contract_unavailable\n");}
        const resolved=await resolveWorkerPools({request:infrastructure.request,workspaceId,controlProjectId:runtimeConfig.projectId,controlEnvironmentId:runtimeConfig.environmentId,region:runtimeConfig.region,pools:poolPolicy,onStage:value=>{stage=value;}});
        controller.configurePools(resolved,controlUrl,excluded=>createWorkerPool({request:infrastructure.request,workspaceId,region:runtimeConfig.region,excludedProjectIds:excluded}));
        configuredWorkspaceId=workspaceId;poolConfigured=true;
        for(const pool of resolved)process.stdout.write(`[InfrastructureBoundary] worker_pool project=${pool.projectId} environment=${pool.environmentId} capacity=${pool.capacity??"railway-quota"}\n`);
      }catch(error){
        const classification=error instanceof InfrastructureRequestError?`${error.category} http=${error.status}`:'verification';
        process.stdout.write(`[InfrastructureBoundary] worker_pools_unavailable stage=${stage} category=${classification}\n`);
        throw error;
      }
    };

    const credentialStore=new RailwayCredentialStore("/data/.infrastructure/railway-credential.json");
    const onboarding=new RailwayOnboardingController({
      controlProjectId:runtimeConfig.projectId,
      client:infrastructure,
      store:credentialStore,
      validate:input=>validateRailwayInfrastructureCredential(input),
      activateWorkspace:configureWorkspace,
    });
    const startupPoolConfiguration=(async()=>{
      try{
        await onboarding.initialize();
        if(!poolConfigured&&infrastructure.configured){
          const result=await infrastructure.request<{project:{workspaceId:string}}>('query WorkerWorkspace($projectId:String!){project(id:$projectId){workspaceId}}',{projectId:runtimeConfig.projectId});
          if(!result.project.workspaceId)throw new Error("Control workspace unavailable");
          await configureWorkspace(result.project.workspaceId);
        }
      }catch{process.stdout.write("[InfrastructureBoundary] railway_onboarding_restore_pending\n");}
    })();
    controller.waitForPoolConfiguration(startupPoolConfiguration);
    gatewayStart=child=>{stopGateway=startNodeGateway(child,nodes,protocol,port,controller,onboarding);};
  }

  const child = await budgetedSpawn("bot-daemon", "/app/railway-volume-maintenance.sh", [], {
    cwd: "/app",
    stdio: gatewayEnabled ? ["inherit","inherit","inherit","ipc"] : "inherit",
    env:{...process.env,...(gatewayEnabled?{CONTROL_APPLICATION_IPC:"1"}:{})},
    uid: 1000,
    gid: 1000,
  });
  process.stdout.write("[InfrastructureBoundary] startup_environment_isolated application_uid=node\n");
  gatewayStart?.(child);

  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { child.kill(signal); });
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
