import assert from "node:assert/strict";
import { test } from "node:test";

test("Railway onboarding keeps candidate token root-side until workspace selection", async () => {
  const loaded = await import("../src/infrastructure/railway-onboarding-controller.js").catch(() => null);
  assert.ok(loaded, "Railway onboarding controller module must exist");
  let configured = "";
  let saved: unknown;
  let activated = "";
  const controller = new loaded.RailwayOnboardingController({
    controlProjectId: "control",
    client: { get configured(){ return Boolean(configured); }, configureCredential(value:string){configured=value;} },
    store: { load: async()=>undefined, save: async(value:unknown)=>{saved=value;} },
    validate: async()=>({ valid:true as const, tokenType:"account" as const, subjectName:"Amin", workspaces:[{id:"w1",name:"Primary"},{id:"w2",name:"Lab"}] }),
    activateWorkspace: async(workspaceId:string)=>{activated=workspaceId;},
    now: ()=>1000,
  });
  assert.deepEqual(await controller.status(), { configured:false });
  const begun = await controller.begin("super-secret");
  assert.deepEqual(begun, { valid:true, tokenType:"account", subjectName:"Amin", workspaces:[{id:"w1",name:"Primary"},{id:"w2",name:"Lab"}] });
  assert.equal(configured, "");
  assert.doesNotMatch(JSON.stringify(begun), /super-secret/);
  const selected = await controller.selectWorkspace("w2");
  assert.deepEqual(selected, { configured:true, tokenType:"account", workspaceId:"w2", workspaceName:"Lab" });
  assert.equal(configured, "super-secret");
  assert.equal(activated, "w2");
  assert.deepEqual(saved, { token:"super-secret", tokenType:"account", workspaceId:"w2", workspaceName:"Lab" });
});

test("Railway onboarding restores persisted credential before provisioning", async () => {
  const { RailwayOnboardingController } = await import("../src/infrastructure/railway-onboarding-controller.js");
  let configured = "";
  let activated = "";
  const persisted = { token:"stored-secret", tokenType:"workspace" as const, workspaceId:"w1", workspaceName:"Primary" };
  const controller = new RailwayOnboardingController({
    controlProjectId:"control",
    client:{get configured(){return Boolean(configured);},configureCredential(value:string){configured=value;}},
    store:{load:async()=>persisted,save:async()=>{}},
    validate:async()=>({valid:false as const,reason:"invalid" as const}),
    activateWorkspace:async(workspaceId:string)=>{activated=workspaceId;},
  });
  await controller.initialize();
  assert.equal(configured,"stored-secret");
  assert.equal(activated,"w1");
  assert.deepEqual(await controller.status(),{configured:true,tokenType:"workspace",workspaceId:"w1",workspaceName:"Primary"});
});


test("Railway workspace activation failure keeps the candidate retryable and does not persist it", async () => {
  const { RailwayOnboardingController } = await import("../src/infrastructure/railway-onboarding-controller.js");
  let activationAttempts=0;
  let saves=0;
  const controller = new RailwayOnboardingController({
    controlProjectId:"control",
    client:{configured:false,configureCredential(){}},
    store:{load:async()=>undefined,save:async()=>{saves++;}},
    validate:async()=>({valid:true as const,tokenType:"account" as const,workspaces:[{id:"w1",name:"Primary"}]}),
    activateWorkspace:async()=>{activationAttempts++;if(activationAttempts===1)throw new Error("temporary activation failure");},
    now:()=>1000,
  });
  await controller.begin("retry-secret");
  await assert.rejects(controller.selectWorkspace("w1"));
  assert.equal(saves,0);
  assert.deepEqual(await controller.status(),{configured:false});
  assert.deepEqual(await controller.selectWorkspace("w1"),{configured:true,tokenType:"account",workspaceId:"w1",workspaceName:"Primary"});
  assert.equal(saves,1);
});

test("preconfigured Railway secret has precedence over persisted Telegram onboarding credential", async () => {
  const { RailwayOnboardingController } = await import("../src/infrastructure/railway-onboarding-controller.js");
  let configured = "env-secret";
  let loads = 0;
  let activated = "";
  const controller = new RailwayOnboardingController({
    controlProjectId:"control",
    client:{get configured(){return Boolean(configured);},configureCredential(value:string){configured=value;}},
    store:{load:async()=>{loads++;return {token:"stored-secret",tokenType:"workspace" as const,workspaceId:"old",workspaceName:"Old"};},save:async()=>{}},
    validate:async()=>({valid:false as const,reason:"invalid" as const}),
    activateWorkspace:async(workspaceId:string)=>{activated=workspaceId;},
  });
  await controller.initialize();
  assert.equal(configured,"env-secret");
  assert.equal(loads,0);
  assert.equal(activated,"");
});
