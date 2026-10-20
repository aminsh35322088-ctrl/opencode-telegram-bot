import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEFAULT_RAILWAY_WORKER_SETTINGS } from "../src/infrastructure/railway-worker-settings.js";

test("initial Railway fleet defaults to one project with five warm single-slot Workers", () => {
  assert.equal(DEFAULT_RAILWAY_WORKER_SETTINGS.workersPerProject, 5);
  assert.equal(DEFAULT_RAILWAY_WORKER_SETTINGS.warmCapacity, 5);
});

test("Railway setup progress derives services, volumes, health and project counts from durable bindings", async () => {
  const loaded = await import("../src/bot/services/railway-bootstrap-progress.js").catch(() => null);
  assert.ok(loaded, "Railway bootstrap progress module must exist");
  const progress = loaded.summarizeRailwayBootstrap([
    { projectId:"p1", serviceId:"s1", volumeId:"v1", status:"available" },
    { projectId:"p1", serviceId:"s2", volumeId:"v2", status:"pool-provisioning" },
    { projectId:"p1", status:"pool-reserved" },
  ], 1, 5);
  assert.deepEqual(progress, { projects:1, projectsTarget:1, workers:2, workersTarget:5, volumes:2, volumesTarget:5, healthy:1, healthyTarget:5, complete:false });
  const text = loaded.renderRailwayBootstrapProgress(progress);
  assert.match(text, /🚂 <b>Setting up Railway<\/b>/);
  assert.match(text, /✅ Projects created 1\/1/);
  assert.match(text, /⏳ Workers created 2\/5/);
  assert.match(text, /⏳ Deploy &amp; health checks 1\/5/);
});

test("Railway bootstrap only exposes Continue after all five Workers are healthy", async () => {
  const loaded = await import("../src/bot/services/railway-bootstrap-progress.js").catch(() => null);
  assert.ok(loaded, "Railway bootstrap progress module must exist");
  const bindings = Array.from({length:5},(_,index)=>({projectId:"p1",serviceId:`s${index}`,volumeId:`v${index}`,status:"available"}));
  const progress = loaded.summarizeRailwayBootstrap(bindings, 1, 5);
  assert.equal(progress.complete,true);
  assert.match(loaded.renderRailwayBootstrapProgress(progress), /🚂 <b>Railway Ready<\/b>/);
});

test("Telegram onboarding gates Main panel behind bootstrap Continue and supports a blocked Railway secret", async () => {
  const onboarding = await readFile(new URL("../src/bot/commands/railway-onboarding-command.ts", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../src/infrastructure/launcher.ts", import.meta.url), "utf8");
  const startup = await readFile(new URL("../src/app/bootstrap/start-bot-app.ts", import.meta.url), "utf8");
  assert.match(onboarding, /railway:continue/);
  assert.match(onboarding, /bootstrapPool\(/);
  assert.match(onboarding, /settings\.update/);
  assert.match(onboarding, /RailwaySetupCompleted/);
  assert.match(onboarding, /secret-invalid/);
  assert.match(launcher, /secret-invalid/);
  assert.match(launcher, /validateRailwayInfrastructureCredential/);
  assert.match(startup, /workerPoolReleaseReconcile/);
  assert.match(startup, /bootstrapPool\(undefined,\s*false\)/, "startup may finish existing reservations, while lifecycle still skips Topic-bound slots");
  assert.doesNotMatch(startup, /bootstrapPool\(INITIAL_BOOTSTRAP_WORKERS/, "new fleet capacity remains onboarding-owned");
});

test("Railway bootstrap self-heals transient Worker readiness failures without asking for /start", async () => {
  const onboarding = await readFile(new URL("../src/bot/commands/railway-onboarding-command.ts", import.meta.url), "utf8");
  assert.doesNotMatch(onboarding, /Setup paused\. Run \/start/);
  assert.match(onboarding, /isRetryableRailwayBootstrapError/);
  assert.match(onboarding, /bootstrapPool\(INITIAL_BOOTSTRAP_WORKERS\)/);
  assert.match(onboarding, /retry/i);
});

test("Railway bootstrap retry classification only loops recoverable failures", async () => {
  const {isRetryableRailwayBootstrapError}=await import("../src/bot/commands/railway-onboarding-command.js");
  const {WorkerProvisioningError}=await import("../src/infrastructure/worker-provisioning-driver.js");
  assert.equal(isRetryableRailwayBootstrapError(new Error("Node transport failed")),true);
  assert.equal(isRetryableRailwayBootstrapError(new Error("Topic node readiness timed out")),true);
  assert.equal(isRetryableRailwayBootstrapError(new Error("Infrastructure operation failed (rate_limit, HTTP 429)")),true);
  assert.equal(isRetryableRailwayBootstrapError(new WorkerProvisioningError("provisioning_pending")),true);
  assert.equal(isRetryableRailwayBootstrapError(new WorkerProvisioningError("project_unavailable")),true);
  assert.equal(isRetryableRailwayBootstrapError(new Error("Infrastructure operation failed (verification, HTTP 0): boundary_replay_http_200")),false);
  for(const category of ["capacity_exhausted","image_unavailable","reconciliation_required","image_mismatch"] as const){
    assert.equal(isRetryableRailwayBootstrapError(new WorkerProvisioningError(category)),false,category);
  }
});

test("limited onboarding requires an actual Railway quota rejection and verified capacity", async () => {
  const {canContinueRailwayBootstrapWithLimitedResources,renderRailwayBootstrapLimit,summarizeRailwayBootstrap}=await import("../src/bot/services/railway-bootstrap-progress.js");
  const bindings=Array.from({length:4},(_,index)=>({projectId:"p",serviceId:`s${index}`,volumeId:`v${index}`,status:"available"}));
  const progress=summarizeRailwayBootstrap(bindings,1,5);
  const quota=new Error("Infrastructure operation failed (resource_limit, HTTP 200)");
  assert.equal(canContinueRailwayBootstrapWithLimitedResources(progress,quota),true);
  for(const error of [new Error("Infrastructure operation failed (verification, HTTP 200): boundary_replay_http_200"),new Error("Node transport failed"),new Error("NO WORKER AVAILABLE / CAPACITY EXHAUSTED"),new Error("Infrastructure operation failed (schema, HTTP 200)")]){
    assert.equal(canContinueRailwayBootstrapWithLimitedResources(progress,error),false);
  }
  assert.equal(canContinueRailwayBootstrapWithLimitedResources({...progress,healthy:0},quota),false);
  const text=renderRailwayBootstrapLimit(progress);
  assert.match(text,/Free plan limit/);
  assert.match(text,/4\/5/);
  assert.match(text,/4 verified Workers/);
  assert.doesNotMatch(text,/\\n/);
  assert.equal(progress.complete,false);
  assert.equal(progress.workersTarget,5);
});

test('live empty inventory overrides four persisted services after reset',async()=>{
 const {summarizeObservedRailwayBootstrap}=await import('../src/bot/services/railway-bootstrap-progress.js');
 const stale=Array.from({length:4},(_,i)=>({nodeId:`n${i}`,generation:1,slot:i+1,projectId:'deleted',serviceId:`s${i}`,volumeId:`v${i}`,status:'available'}));
 const progress=summarizeObservedRailwayBootstrap(stale,[],0,5);
 assert.equal(progress.workers,0);assert.equal(progress.volumes,0);assert.equal(progress.healthy,0);assert.equal(progress.projects,0);assert.equal(progress.complete,false);
});
test('live inventory cannot count another generation as ready',async()=>{
 const {summarizeObservedRailwayBootstrap}=await import('../src/bot/services/railway-bootstrap-progress.js');
 const progress=summarizeObservedRailwayBootstrap([{nodeId:'n',generation:2,status:'available'}],[{nodeId:'n',generation:1,projectId:'p',serviceId:'s',volumeId:'v'}],1,5);
 assert.equal(progress.workers,0);assert.equal(progress.healthy,0);
});

test('an available binding cannot announce healthy before Root boundary verification',async()=>{
 const {summarizeObservedRailwayBootstrap}=await import('../src/bot/services/railway-bootstrap-progress.js');
 const binding={nodeId:'n',generation:1,status:'available'};
 const worker={nodeId:'n',generation:1,projectId:'p',serviceId:'s',volumeId:'v',verified:false};
 assert.equal(summarizeObservedRailwayBootstrap([binding],[worker],1,1).complete,false);
 assert.equal(summarizeObservedRailwayBootstrap([binding],[{...worker,verified:true}],1,1).complete,true);
});

test('unverified inventory hides cached counts and cannot unlock limited Continue',async()=>{
 const {summarizeRailwayBootstrap,renderRailwayBootstrapProgress,canContinueRailwayBootstrapWithLimitedResources}=await import('../src/bot/services/railway-bootstrap-progress.js');
 const progress={...summarizeRailwayBootstrap([{serviceId:'s',volumeId:'v',status:'available'}],1,5),complete:false,verified:false};
 const text=renderRailwayBootstrapProgress(progress);
 assert.match(text,/Workers created —\/5/);assert.doesNotMatch(text,/Workers created 1\/5/);
 assert.equal(canContinueRailwayBootstrapWithLimitedResources(progress,new Error('Infrastructure operation failed (resource_limit, HTTP 200)')),false);
});
