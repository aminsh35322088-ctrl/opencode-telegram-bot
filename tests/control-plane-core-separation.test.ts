import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = async (path:string) => await readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Railway control-plane image does not materialize or execute OpenCode Core", async () => {
  const dockerfile = await source("Dockerfile");
  assert.doesNotMatch(dockerfile, /materialize-core-release|verify-core-install/);
  assert.doesNotMatch(dockerfile, /\/app\/\.core|\/usr\/local\/bin\/opencode/);
  assert.doesNotMatch(dockerfile, /playwright-cli install-browser/);
  assert.match(dockerfile, /dist\/infrastructure\/launcher\.js/);
});

test("control-plane startup never initializes local Core or OpenCode daemon", async () => {
  const bootstrap = await source("src/app/bootstrap/start-bot-app.ts");
  assert.match(bootstrap, /const distributedControlPlane = process\.env\.CONTROL_APPLICATION_IPC === "1"/);
  assert.match(bootstrap, /if \(!distributedControlPlane\)[\s\S]*initializeNativeCore/);
  assert.match(bootstrap, /if \(!distributedControlPlane\)[\s\S]*opencodeAutoRestartService\.start/);
});
