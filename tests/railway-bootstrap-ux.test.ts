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
  assert.doesNotMatch(startup, /bootstrapPool\(/, "Worker fleet bootstrap must be triggered by onboarding, not generic process startup");
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
  for(const category of ["capacity_exhausted","image_unavailable","reconciliation_required","image_mismatch"] as const){
    assert.equal(isRetryableRailwayBootstrapError(new WorkerProvisioningError(category)),false,category);
  }
});
