import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path: string): Promise<string> {
  return await readFile(new URL(`../${path}`, import.meta.url), "utf8").catch(() => "");
}

test("Railway runtime onboarding crosses only the inherited root IPC boundary", async () => {
  const applicationTransport = await source("src/control-plane/application-transport.ts");
  const gateway = await source("src/infrastructure/node-gateway.ts");
  const launcher = await source("src/infrastructure/launcher.ts");
  const onboarding = await source("src/infrastructure/railway-onboarding-controller.ts");

  assert.match(applicationTransport, /requestInfrastructureSetup/);
  assert.match(applicationTransport, /infrastructure-configure/);
  assert.match(gateway, /infrastructure-configure/);
  assert.match(gateway, /setup\.begin\(token\)/);
  assert.match(onboarding, /configureCredential/);
  assert.match(launcher, /RailwayOnboardingController/);
  assert.match(launcher, /RailwayCredentialStore/);
  assert.match(launcher, /createWorkerPool/);
  assert.doesNotMatch(applicationTransport, /RAILWAY_API_TOKEN/);
});

test("Railway token onboarding never forwards the credential to Workers", async () => {
  const provisioner = await source("src/infrastructure/railway-provisioning-driver.ts");
  const childEnvironment = await source("src/runtime/child-environment.ts");

  assert.match(childEnvironment, /RAILWAY_/);
  assert.doesNotMatch(provisioner, /RAILWAY_API_TOKEN/);
  assert.match(provisioner, /NODE_SHARED_SECRET/);
  assert.match(provisioner, /CONTROL_PLANE_URL/);
});
