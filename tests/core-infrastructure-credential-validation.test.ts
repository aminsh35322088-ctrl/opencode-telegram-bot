import assert from "node:assert/strict";
import { test } from "node:test";

test("Railway account credential validation returns selectable workspaces without exposing the token", async () => {
  const loaded = await import("../src/infrastructure/railway-credential-validation.js").catch(() => null);
  assert.ok(loaded, "Railway credential validation module must exist");
  const seen: string[] = [];
  let call = 0;
  const transport: typeof fetch = async (_url, init) => {
    call++;
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
    seen.push(new Headers(init?.headers).get("authorization") ?? "");
    if (call === 1) {
      assert.match(body.query ?? "", /InfrastructureCredentialAccount/);
      return new Response(JSON.stringify({ data: { me: { id: "u", name: "Amin", email: "a@example.test", workspaces: [{ id: "w1", name: "Primary" }, { id: "w2", name: "Lab" }] } } }), { status: 200 });
    }
    assert.match(body.query ?? "", /InfrastructureCredentialWorkspaceScope/);
    return new Response(JSON.stringify({ data: { project: { workspaceId: "w1" } } }), { status: 200 });
  };
  const result = await loaded.validateRailwayInfrastructureCredential({ token: "secret-account", controlProjectId: "control", transport });
  assert.deepEqual(result, { valid: true, tokenType: "account", subjectName: "Amin", workspaces: [{ id: "w1", name: "Primary" }, { id: "w2", name: "Lab" }] });
  assert.deepEqual(seen, ["Bearer secret-account", "Bearer secret-account"]);
  assert.doesNotMatch(JSON.stringify(result), /secret-account/);
});

test("Railway workspace credential is accepted only when it can read the Control project workspace", async () => {
  const loaded = await import("../src/infrastructure/railway-credential-validation.js").catch(() => null);
  assert.ok(loaded);
  let call = 0;
  const transport: typeof fetch = async (_url, init) => {
    call++;
    const query = (JSON.parse(String(init?.body ?? "{}")) as { query?: string }).query ?? "";
    if (call === 1) {
      assert.match(query, /InfrastructureCredentialAccount/);
      return new Response(JSON.stringify({ errors: [{ message: "Not Authorized" }] }), { status: 200 });
    }
    if (call === 2) {
      assert.match(query, /InfrastructureCredentialWorkspaceScope/);
      return new Response(JSON.stringify({ data: { project: { workspaceId: "w1" } } }), { status: 200 });
    }
    assert.match(query, /InfrastructureCredentialWorkspace/);
    return new Response(JSON.stringify({ data: { workspace: { id: "w1", name: "Primary" } } }), { status: 200 });
  };
  const result = await loaded.validateRailwayInfrastructureCredential({ token: "secret-workspace", controlProjectId: "control", transport });
  assert.deepEqual(result, { valid: true, tokenType: "workspace", workspaces: [{ id: "w1", name: "Primary" }] });
});


test("Railway account credential must be able to read the deployed Control project", async () => {
  const { validateRailwayInfrastructureCredential } = await import("../src/infrastructure/railway-credential-validation.js");
  let call = 0;
  const transport: typeof fetch = async () => {
    call++;
    if (call === 1) return new Response(JSON.stringify({ data: { me: { id: "u", name: "Amin", workspaces: [{ id: "w1", name: "Primary" }] } } }), { status: 200 });
    return new Response(JSON.stringify({ errors: [{ message: "Not Authorized" }] }), { status: 200 });
  };
  assert.deepEqual(await validateRailwayInfrastructureCredential({ token: "account-without-control", controlProjectId: "control", transport }), { valid:false, reason:"scope" });
});
