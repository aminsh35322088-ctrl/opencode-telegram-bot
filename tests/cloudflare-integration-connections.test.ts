import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { SqlDatabase } from "../src/cloudflare/control-store.js";
import { CloudIntegrationConnections } from "../src/cloudflare/integration-connections.js";
import {
  CloudCredentialVault,
  protectTelegramCredentialUpdate,
  readCredentialInput,
} from "../src/cloudflare/credential-vault.js";
const master = btoa("k".repeat(32));
const secret = "github-secret-test";
test("account API diagnostics expose only bounded stage and category, never exception material", async (t) => {
  const logs: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    logs.push(args);
  });
  const f = fixture(async () => {
    throw new TypeError("private-token-in-error");
  });
  await assert.rejects(f.connections.connect("github", secret), /integration_unavailable/);
  assert.match(JSON.stringify(logs), /integration_account_verification_failed/);
  assert.match(JSON.stringify(logs), /transport/);
  assert.equal(JSON.stringify(logs).includes("private-token-in-error"), false);
  assert.equal(JSON.stringify(logs).includes(secret), false);
});
test("prepared rotation preserves the active account until synchronous activation", async () => {
  const f = fixture(async () => Response.json({ login: "operator" }));
  const first = await f.connections.connect("github", secret);
  const prepared = await f.connections.prepare("github", "replacement-secret");
  assert.equal(await f.connections.readCredential("github", first.credentialId), secret);
  await assert.rejects(f.connections.readCredential("github", prepared.credentialId));
  f.connections.activate(prepared);
  await assert.rejects(f.connections.readCredential("github", first.credentialId));
  assert.equal(
    await f.connections.readCredential("github", prepared.credentialId),
    "replacement-secret",
  );
});
test("multiple accounts keep separate encrypted references and switch without changing credentials", async () => {
  const f = fixture(async () => Response.json({ login: "operator" }));
  const first = await f.connections.connect("github", secret);
  const second = await f.connections.prepare("github", "second-account-secret");
  f.connections.activate(second, "add");
  assert.equal(f.connections.accounts("github").length, 2);
  f.connections.select("github", first.credentialId);
  assert.equal(await f.connections.readCredential("github", first.credentialId), secret);
  assert.equal(
    f.connections.accounts("github").some((a) => a.credentialId === second.credentialId),
    true,
  );
  const replacement = await f.connections.prepare("github", "rotated-secret");
  f.connections.activate(replacement);
  assert.equal(f.connections.accounts("github").length, 2);
  assert.equal(
    f.connections.accounts("github").some((a) => a.credentialId === first.credentialId),
    false,
  );
  f.connections.select("github", second.credentialId);
  assert.equal(
    await f.connections.readCredential("github", second.credentialId),
    "second-account-secret",
  );
  assert.equal(f.dump().includes("second-account-secret"), false);
});
function fixture(fetcher: typeof fetch) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ui_state(key TEXT PRIMARY KEY,data TEXT NOT NULL)");
  const sql: SqlDatabase = { exec: (q, ...v) => db.prepare(q).all(...v) as never };
  return {
    db,
    sql,
    connections: new CloudIntegrationConnections(sql, master, fetcher),
    dump: () => JSON.stringify(db.prepare("SELECT * FROM ui_state").all()),
  };
}
test("GitHub validates identity before encrypted storage and grants no execution capability", async () => {
  const f = fixture(async (url, options) => {
    assert.equal(url, "https://api.github.com/user");
    assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${secret}`);
    assert.equal(options?.redirect, "manual");
    assert.ok(options?.signal);
    return Response.json({ login: "operator" });
  });
  const result = await f.connections.connect("github", secret);
  assert.equal(result.username, "operator");
  assert.equal(result.accountConnected, true);
  assert.equal(result.connected, false);
  assert.equal(result.reason, "core_runtime_unavailable");
  assert.equal(f.dump().includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(await f.connections.readCredential("github", result.credentialId), secret);
  await assert.rejects(
    new CloudCredentialVault(f.sql, master).readLease(result.capability, result.credentialId),
    /invalid_credential/,
  );
  await assert.rejects(
    f.connections.readCredential("tailscale", result.credentialId),
    /invalid_integration_credential/,
  );
});
test("rejected GitHub login never stores credentials or upstream error secrets", async () => {
  for (const response of [
    new Response(secret, { status: 401 }),
    new Response(secret, { status: 403 }),
    Response.json({ login: "" }),
    Response.json({ login: "bad\nname" }),
  ]) {
    const f = fixture(async () => response);
    await assert.rejects(
      f.connections.connect("github", secret),
      /^Error: integration_(?:unauthorized|forbidden|invalid_response)$/,
    );
    assert.equal(f.dump(), "[]");
  }
  const f = fixture(async () => {
    throw new Error(secret);
  });
  await assert.rejects(f.connections.connect("github", secret), /^Error: integration_unavailable$/);
  assert.equal(f.dump(), "[]");
});
test("Tailscale verifies default tailnet API access without claiming VPN or exposing device data", async () => {
  const token = "tskey-api-secret-test";
  const f = fixture(async (url, options) => {
    assert.equal(url, "https://api.tailscale.com/api/v2/tailnet/-/devices");
    assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${token}`);
    return Response.json({ devices: [{ hostname: "private-host", addresses: ["100.1.1.1"] }] });
  });
  const result = await f.connections.connect("tailscale", token);
  assert.equal(result.accountConnected, true);
  assert.equal(result.connected, false);
  assert.equal(result.tailnet, "-");
  assert.equal(result.visibleDevices, 1);
  assert.equal(f.dump().includes(token), false);
  assert.equal(f.dump().includes("private-host"), false);
  assert.equal(f.dump().includes("100.1.1.1"), false);
});
test("Tailscale device auth keys and invalid input fail before network or storage", async () => {
  const f = fixture(async () => {
    assert.fail("must not call API");
  });
  await assert.rejects(
    f.connections.connect("tailscale", "tskey-auth-secret-test"),
    /^Error: tailscale_api_token_required$/,
  );
  for (const token of ["", "bad\nsecret", "bad\0secret", "a".repeat(16385)])
    await assert.rejects(
      f.connections.connect("github", token),
      /^Error: invalid_integration_credential$/,
    );
  await assert.rejects(
    f.connections.connect("railway" as never, secret),
    /^Error: invalid_integration$/,
  );
  assert.equal(f.dump(), "[]");
});
test("rotation and removal invalidate old integration references, corruption errors hide secrets", async () => {
  const f = fixture(async () => Response.json({ login: "operator" }));
  const first = await f.connections.connect("github", secret);
  const second = await f.connections.connect("github", "rotated-secret");
  await assert.rejects(
    f.connections.readCredential("github", first.credentialId),
    /^Error: invalid_integration_credential$/,
  );
  await assert.rejects(
    new CloudIntegrationConnections(f.sql, "bad").readCredential("github", second.credentialId),
    /^Error: invalid_integration_credential$/,
  );
  const row = f.db
    .prepare("SELECT data FROM ui_state WHERE key=?")
    .get("integration-credential:github") as { data: string };
  const forged = JSON.parse(row.data);
  forged.credentialId = first.credentialId;
  f.sql.exec(
    "UPDATE ui_state SET data=? WHERE key=?",
    JSON.stringify(forged),
    "integration-credential:github",
  );
  await assert.rejects(
    f.connections.readCredential("github", first.credentialId),
    /^Error: invalid_integration_credential$/,
  );
  f.connections.remove("github");
  assert.equal(f.dump(), "[]");
});
test("integration credential Telegram forms are encrypted before durable ingress", async () => {
  const f = fixture(async () => {
    assert.fail("not used");
  });
  f.sql.exec(
    "INSERT INTO ui_state VALUES(?,?)",
    "form:7:-100:2",
    JSON.stringify({
      kind: "credential",
      providerId: "integration.github",
      generation: 3,
      expires: Date.now() + 60000,
    }),
  );
  const update = {
    update_id: 42,
    message: {
      message_id: 9,
      chat: { id: -100 },
      from: { id: 7 },
      message_thread_id: 2,
      text: secret,
    },
  };
  const protectedUpdate = await protectTelegramCredentialUpdate(update, f.sql, master);
  assert.equal(JSON.stringify(protectedUpdate).includes(secret), false);
  assert.equal(
    await readCredentialInput(protectedUpdate, master, {
      actor: 7,
      chat: -100,
      thread: 2,
      generation: 3,
      providerId: "integration.github",
    }),
    secret,
  );
});

test("malformed and oversized API responses never persist integration credentials", async () => {
  for (const response of [
    new Response("not-json"),
    new Response("x".repeat(1024 * 1024 + 1)),
    Response.json({}),
  ]) {
    const f = fixture(async () => response);
    await assert.rejects(
      f.connections.connect("tailscale", "tskey-api-secret-test"),
      /^Error: integration_invalid_response$/,
    );
    assert.equal(f.dump(), "[]");
  }
});

test("failed replacement preserves the existing encrypted GitHub credential", async () => {
  let unauthorized = false;
  const f = fixture(async () =>
    unauthorized ? new Response("denied", { status: 401 }) : Response.json({ login: "operator" }),
  );
  const first = await f.connections.connect("github", secret);
  unauthorized = true;
  await assert.rejects(
    f.connections.connect("github", "rejected-secret"),
    /^Error: integration_unauthorized$/,
  );
  assert.equal(await f.connections.readCredential("github", first.credentialId), secret);
  assert.equal(f.dump().includes("rejected-secret"), false);
});
