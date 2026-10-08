import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type FleetTopic, type SqlDatabase } from "../src/cloudflare/control-store.js";
import { LegacyUiAdapter } from "../src/cloudflare/legacy-ui-adapter.js";
import { LegacyModelAdapter } from "../src/cloudflare/legacy-model-adapter.js";
import {
  buildModelCenterProvider,
  buildModelCenterRoot,
  buildModelCenterSearchResults,
} from "../src/bot/menus/model-center-menu.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = { exec: (q, ...v) => db.prepare(q).all(...v) as never };
  const store = new ControlStore(sql, (fn) => fn());
  store.setGlobal({ configuration: { runtime: { model: "p/m0" } }, defaults: {} }, "hash");
  const topic: FleetTopic = {
    chatId: -100,
    threadId: 42,
    workerId: "worker",
    generation: 1,
    sessionId: "session",
    state: "ACTIVE",
  };
  sql.exec("INSERT INTO topics VALUES(?,?,?,?)", topic.chatId, topic.threadId, topic.workerId, JSON.stringify(topic));
  let providers: unknown[] = [
    {
      id: "p",
      name: "Provider",
      models: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`m${i}`, { name: `Model ${i}` }]),
      ),
    },
  ];
  const rpc: string[] = [];
  const ui = new LegacyUiAdapter({
    sql,
    store,
    botVersion: "0.26.2",
    coreVersion: "1.18.33-bot.13-pre.25",
    rpc: async (_topic, operation) => {
      rpc.push(operation);
      if (operation === "models.list") return { providers } as never;
      if (operation === "model.inspect") return { connected: true, available: true } as never;
      return undefined as never;
    },
    commitGlobal: async (data, expectedRevision) => {
      store.setGlobal(data, "next", expectedRevision);
    },
  });
  return {
    ui,
    models: new LegacyModelAdapter(ui),
    topic,
    rpc,
    setProviders(value: unknown[]) {
      providers = value;
    },
  };
}

test("canonical Model Center builders preserve legacy root, provider pagination and search", async () => {
  const f = fixture();
  const scope = { kind: "topic" as const, topic: f.topic };
  await f.models.providers(scope);
  const source = f.models.source(scope);
  const current = await f.models.current(f.topic);

  const root = await buildModelCenterRoot(current, source);
  assert.match(root.text, /🤖 <b>MODEL CENTER<\/b>/);
  const rootLabels = root.keyboard.inline_keyboard.flat().map((button) => button.text);
  assert.deepEqual(rootLabels, [
    "⭐ Favorites · 0",
    "🕘 Recent models · 0",
    "🔎 Search models",
    "🧩 Browse providers",
    "← Back",
  ]);

  const provider = (await f.models.providers(scope))[0]!;
  const page = await buildModelCenterProvider(provider, 0, current, undefined, source);
  assert.match(page.text, /10 live models · page 1\/2/);
  assert.equal(page.keyboard.inline_keyboard.flat().some((button) => button.text === "Next ›"), true);

  const search = await buildModelCenterSearchResults("model 9", current, source);
  assert.match(search.text, /SEARCH/);
  assert.equal(search.keyboard.inline_keyboard.flat().some((button) => /Model 9/.test(button.text)), true);
});

test("model selection revalidates the live Topic catalog and refuses a disappeared model", async () => {
  const f = fixture();
  const scope = { kind: "topic" as const, topic: f.topic };
  await f.models.providers(scope);
  f.setProviders([{ id: "p", name: "Provider", models: {} }]);
  await assert.rejects(
    f.models.select(scope, { providerID: "p", modelID: "m1" }),
    /model_unavailable/,
  );
  assert.equal(f.ui.getTopicSelection(f.topic).model, "p/m0");
  assert.equal(f.rpc.includes("model.inspect"), false);
});

test("favorites and recent selections are durable and generation scoped", async () => {
  const f = fixture();
  const scope = { kind: "topic" as const, topic: f.topic };
  await f.models.providers(scope);
  await f.models.setFavorite(scope, { providerID: "p", modelID: "m1", name: "Model 1" }, true);
  assert.equal((await f.models.favorites(scope))[0]?.modelID, "m1");
  await f.models.select(scope, { providerID: "p", modelID: "m2", name: "Model 2" });
  assert.equal(f.ui.getTopicSelection(f.topic).model, "p/m2");
  assert.equal((await f.models.recent(scope))[0]?.modelID, "m2");

  const staleScope = { kind: "topic" as const, topic: { ...f.topic, generation: 0 } };
  await assert.rejects(
    f.models.select(staleScope, { providerID: "p", modelID: "m2" }),
    /stale_generation/,
  );
});
