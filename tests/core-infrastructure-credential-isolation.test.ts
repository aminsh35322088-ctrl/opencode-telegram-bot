import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { budgetedExec, budgetedExecFile, budgetedSpawn } from "../src/runtime/process-budget.js";

const probe = "process.stdout.write(String(Object.keys(process.env).some(k => /^RAILWAY_(API|PROJECT)?_?TOKEN$/i.test(k))))";

test("all governed children strip infrastructure credentials from inherited and explicit environments", async () => {
  const previous = process.env.RAILWAY_API_TOKEN;
  process.env.RAILWAY_API_TOKEN = "synthetic-test-value";
  try {
    const explicit = { ...process.env, railway_api_token: "synthetic-override", RAILWAY_TOKEN: "synthetic-project-value" };
    const execFile = await budgetedExecFile("diagnostic", process.execPath, ["-e", probe], { env: explicit });
    assert.equal(execFile.stdout, "false");
    const exec = await budgetedExec("diagnostic", `${process.execPath} -e '${probe}'`, { env: explicit });
    assert.equal(exec.stdout, "false");
    const child = await budgetedSpawn("diagnostic", process.execPath, ["-e", probe], { env: explicit });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    assert.equal(output, "false");
    assert.equal(process.env.RAILWAY_API_TOKEN, "synthetic-test-value", "the control process retains ownership");
    assert.equal(explicit.RAILWAY_TOKEN, "synthetic-project-value", "caller environment is not mutated");
  } finally {
    if (previous === undefined) delete process.env.RAILWAY_API_TOKEN;
    else process.env.RAILWAY_API_TOKEN = previous;
  }
});
