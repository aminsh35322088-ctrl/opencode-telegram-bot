import {WORKER_RUNTIME_IMAGE} from "./worker-core-release.js";
import { createInfrastructureClient, InfrastructureRequestError } from "./railway-client.js";
import { lstat } from "node:fs/promises";
import { constants } from "node:os";
import type { ChildProcess } from "node:child_process";
import {budgetedExecFile,budgetedSpawn} from "../runtime/process-budget.js";
import {captureNodeRegistry} from "./node-registry.js";
import {resolveControlRuntimeConfig,configureApplicationEnvironment} from "./control-runtime-config.js";
import {startTailscaledDaemon} from "./tailscaled-daemon.js";
import {DEFAULT_RAILWAY_WORKER_SETTINGS,RailwayWorkerSettingsStore,type RailwayWorkerSettings} from "./railway-worker-settings.js";

// This process is the only infrastructure credential owner. Railway starts it as
// root; the launcher drops the Telegram/orchestration application to the node user.
// OpenCode Core is never started in this service; it exists only in Worker images.
// The credential never enters Worker variables, model state or application storage.
const nodes=captureNodeRegistry(process.env);
// Capture only inside the privileged launcher. createInfrastructureClient immediately
// strips the credential from the environment inherited by the application child.
const railwaySecretToken=process.env.RAILWAY_API_TOKEN?.trim();
const railwaySecretPresent=Boolean(railwaySecretToken);
const infrastructure = createInfrastructureClient(process.env);
const existingVariableNames=Object.keys(process.env);
const workerImage=WORKER_RUNTIME_IMAGE;
const runtimeConfig=resolveControlRuntimeConfig(process.env,infrastructure.configured,nodes.metadata().length>0);
configureApplicationEnvironment(process.env);

async function main(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("Infrastructure launcher requires a separate privileged identity");
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
    await budgetedExecFile("cleanup","/usr/bin/chown", ["--no-dereference", "1000:1000", "/data"]);
  }

  let stopGateway:(()=>void)|undefined;
  let gatewayStart:((child:ChildProcess)=>void)|undefined;
  let workerSettings:RailwayWorkerSettings={...DEFAULT_RAILWAY_WORKER_SETTINGS};
  const workerSettingsStore=new RailwayWorkerSettingsStore("/data/.infrastructure/worker-settings.json");
  if(gatewayEnabled){
    workerSettings=await workerSettingsStore.load();
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
    const {NodeBootstrapGrantStore}=await import("./node-bootstrap-grants.js");
    const bootstrapGrants=new NodeBootstrapGrantStore(nodes,"/data/.infrastructure/nodes.json");
    const {WORKER_CORE_COMMIT}=await import("./worker-core-release.js");
    const controller=new InfrastructureController({coreCommit:WORKER_CORE_COMMIT,workerImage,registry:nodes,stateDirectory:"/data/.infrastructure",bindingFilename:`${getRuntimePaths().appHome}/control-plane/node-bindings.json`,request:infrastructure.request,
      retireNode:(identity,sanitize=false)=>retirementTransport.retireFenced(identity,sanitize),
      issueBootstrap:(binding,endpoint,secret)=>{if(!binding.serviceId||!binding.projectId)throw new Error("Worker bootstrap resource identity missing");return bootstrapGrants.issue({identity:{nodeId:binding.nodeId,generation:binding.generation,chatId:binding.chatId,threadId:binding.threadId},endpoint,secret,serviceId:binding.serviceId,projectId:binding.projectId});},
      rotateNode:(identity,bootstrapToken,target)=>retirementTransport.rotateFenced(identity,bootstrapToken,{nodeId:target.nodeId,generation:target.generation,chatId:target.chatId,threadId:target.threadId}),
      probeUnbound:(nodeId,generation)=>retirementTransport.probeUnboundBoundary(nodeId,generation),onClusterVerified:async()=>{
      if(!infrastructure.configured)return;
      try{
        const {verifyWorkerRuntimeCanary}=await import("./worker-runtime-canary.js");
        await verifyWorkerRuntimeCanary({journalPath:"/data/.infrastructure/provisioning.json",selftest:(nodeId,generation,profile)=>retirementTransport.runtimeSelftest(nodeId,generation,profile),log:message=>{process.stdout.write(message);},afterVerified:async(nodeId,generation)=>{
          await controller.cleanupRuntimeCanaryVariables(nodeId,generation,(id,epoch,profile)=>retirementTransport.runtimeSelftest(id,epoch,profile));
          process.stdout.write(`[InfrastructureBoundary] worker_variables_reconciled node=${nodeId} generation=${generation} contract=identity-v1 restartVerification=pending\n`);
        }});
      }catch{
        process.stdout.write("[InfrastructureBoundary] worker_runtime_canary_pending\n");
        throw new Error("Worker runtime cluster canary failed");
      }
    }});

    let configuredWorkspaceId:string|undefined;
    let configuredWorkspaceName:string|undefined;
    let secretTokenType:"account"|"workspace"="workspace";
    let secretInvalid=false;
    let poolConfigured=false;
    const deletedWorkerProjectIds=new Set<string>();
    let deletedWorkers:Array<{nodeId:string;generation:number}>=[];
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
        const resolved=(await resolveWorkerPools({request:infrastructure.request,workspaceId,controlProjectId:runtimeConfig.projectId,controlEnvironmentId:runtimeConfig.environmentId,region:runtimeConfig.region,onDeletedProjects:ids=>{for(const id of ids)deletedWorkerProjectIds.add(id);},onStage:value=>{stage=value;}})).map(pool=>({...pool,capacity:workerSettings.workersPerProject}));
        controller.configurePools(resolved,controlUrl,async excluded=>{
          const created=await createWorkerPool({request:infrastructure.request,workspaceId,region:runtimeConfig.region,excludedProjectIds:excluded});
          return {...created,capacity:workerSettings.workersPerProject};
        });
        deletedWorkers=await controller.discardDeletedProjects([...deletedWorkerProjectIds]);
        configuredWorkspaceId=workspaceId;poolConfigured=true;
        for(const pool of resolved)process.stdout.write(`[InfrastructureBoundary] worker_pool project=${pool.projectId} environment=${pool.environmentId} capacity=${pool.capacity??"railway-quota"}\n`);
        try{
          const {cleanupDeprecatedControlVariables}=await import("./control-variable-cleanup.js");
          await cleanupDeprecatedControlVariables({request:infrastructure.request,projectId:runtimeConfig.projectId,environmentId:runtimeConfig.environmentId,serviceId:runtimeConfig.serviceId,names:existingVariableNames});
          process.stdout.write("[InfrastructureBoundary] control_variables_reconciled contract=telegram-and-railway-credentials-only\n");
        }catch{process.stdout.write("[InfrastructureBoundary] control_variable_cleanup_pending\n");}
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
        if(railwaySecretPresent){
          const validation=await validateRailwayInfrastructureCredential({token:railwaySecretToken!,controlProjectId:runtimeConfig.projectId});
          if(!validation.valid){secretInvalid=true;process.stdout.write(`[InfrastructureBoundary] railway_secret_rejected reason=${validation.reason}\n`);return;}
          secretTokenType=validation.tokenType;
          const result=await infrastructure.request<{project:{workspaceId:string}}>('query WorkerWorkspace($projectId:String!){project(id:$projectId){workspaceId}}',{projectId:runtimeConfig.projectId});
          if(!result.project.workspaceId)throw new Error("Control workspace unavailable");
          configuredWorkspaceName=validation.workspaces.find(item=>item.id===result.project.workspaceId)?.name;
          await configureWorkspace(result.project.workspaceId);
          process.stdout.write("[InfrastructureBoundary] railway_secret_verified source=environment\n");
          return;
        }
        await onboarding.initialize();
        if(!poolConfigured&&infrastructure.configured){
          const result=await infrastructure.request<{project:{workspaceId:string}}>('query WorkerWorkspace($projectId:String!){project(id:$projectId){workspaceId}}',{projectId:runtimeConfig.projectId});
          if(!result.project.workspaceId)throw new Error("Control workspace unavailable");
          await configureWorkspace(result.project.workspaceId);
        }
      }catch{
        if(railwaySecretPresent)secretInvalid=true;
        process.stdout.write("[InfrastructureBoundary] railway_onboarding_restore_pending\n");
      }
    })();
    controller.waitForPoolConfiguration(startupPoolConfiguration);
    const setupController={
      status:async()=>{
        await startupPoolConfiguration.catch(()=>undefined);
        const inventory=poolConfigured?await controller.bootstrapInventory():{projectCount:0,workers:[]};
        const {projectCount}=inventory;
        const observed={projectCount,workers:inventory.workers,deletedWorkers,deletedProjectIds:[...deletedWorkerProjectIds]};
        if(railwaySecretPresent){
          if(secretInvalid||!poolConfigured||!configuredWorkspaceId)return {configured:false as const,blockedReason:"secret-invalid" as const,...observed};
          return {configured:true as const,tokenType:secretTokenType,workspaceId:configuredWorkspaceId,...(configuredWorkspaceName?{workspaceName:configuredWorkspaceName}:{}),...observed};
        }
        const current=await onboarding.status();
        if(current.configured)return {...current,...observed};
        if(infrastructure.configured&&configuredWorkspaceId)return {configured:true as const,tokenType:"workspace" as const,workspaceId:configuredWorkspaceId,...observed};
        return {...current,...observed};
      },
      begin:(token:string)=>onboarding.begin(token),
      selectWorkspace:async(workspaceId:string)=>{const result=await onboarding.selectWorkspace(workspaceId);configuredWorkspaceName=result.configured?result.workspaceName:undefined;return result;},
      getSettings:async()=>({...workerSettings}),
      updateSettings:async(patch:unknown)=>{workerSettings=await workerSettingsStore.update(patch);controller.setPoolCapacity(workerSettings.workersPerProject);return {...workerSettings};},
    };
    gatewayStart=child=>{stopGateway=startNodeGateway(child,nodes,protocol,port,controller,setupController,bootstrapGrants);};
  }

  // The single shared Tailscale daemon is owned by this privileged launcher and
  // runs as the application identity. Settings/tools talk to its socket; Topic
  // Workers keep their own on-demand enrollment. Boot continues without the
  // daemon: the Tailscale UI falls back to Topic-Worker mode until redeploy.
  const tailscaled: { ok: boolean; pid?: number; reason?: string } = await startTailscaledDaemon({ uid: 1000, gid: 1000 })
    .catch((error: unknown) => ({ ok: false as const, reason: `error:${String(error)}` }));
  if (tailscaled.ok) process.stdout.write(`[InfrastructureBoundary] tailscaled_ready pid=${tailscaled.pid}\n`);
  else process.stdout.write(`[InfrastructureBoundary] tailscaled_unavailable reason=${tailscaled.reason}\n`);

  const child = await budgetedSpawn("bot-daemon",process.execPath, ["/app/dist/index.js"], {
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
