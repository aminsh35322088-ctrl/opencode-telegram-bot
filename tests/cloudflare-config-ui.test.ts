import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ControlStore, type SqlDatabase } from "../src/cloudflare/control-store.js";
import { CloudConfigUi, type ConfigContext } from "../src/cloudflare/config-ui.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDatabase = { exec: (q, ...v) => db.prepare(q).all(...v) as never };
  const store = new ControlStore(sql, (fn) => {
    db.exec("BEGIN");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  });
  store.setGlobal(
    {
      configuration: {
        runtime: { mcp: { demo: { type: "remote", url: "https://example.com", enabled: true } } },
      },
      skills: [],
      actions: [],
      defaults: {},
      credentialReferences: [],
    },
    "initial",
  );
  const messages: string[] = [];
  const prompts: string[] = [];
  let revision: number | undefined;
  const context: ConfigContext = {
    draftKey: "config-draft:test",
    store,
    sql,
    telegram: {} as never,
    commit: async (data, r) => {
      revision = r;
      store.setGlobal(data, "changed", r);
    },
    button: (text, action, value) => ({ text, callback_data: JSON.stringify({ action, value }) }),
    menu: async (text) => {
      messages.push(text);
    },
    notice: async (text) => {
      messages.push(text);
    },
    prompt: async (kind) => {
      prompts.push(kind);
    },
  };
  const ui = new CloudConfigUi(context);
  return {
    ui,
    context,
    sql,
    store,
    messages,
    prompts,
    get revision() {
      return revision;
    },
  };
}
test("MCP toggle changes canonical runtime and commits expected revision", async () => {
  const f = fixture();
  await f.ui.handle("config_toggle_mcps", "demo");
  assert.equal(f.revision, 1);
  assert.equal(f.store.global()?.revision, 2);
  assert.equal((f.store.global()?.data.configuration as any).runtime.mcp.demo.enabled, false);
});
test("invalid or secret-bearing provider input never commits or echoes input", async () => {
  const f = fixture();
  await assert.rejects(
    f.ui.handle("config_save_providers", JSON.stringify({ id: "test", apiKey: "SECRET_VALUE" })),
  );
  assert.equal(f.store.global()?.revision, 1);
  assert.ok(!f.messages.join("").includes("SECRET_VALUE"));
});
test("skill create and remove updates content hash and survives revision changes", async () => {
  const f = fixture();
  await f.ui.handle(
    "config_save_skills",
    JSON.stringify({ name: "demo", content: "# Demo\nUse this." }),
  );
  const skill = (f.store.global()?.data.skills as any[])[0];
  assert.equal(skill.content, "# Demo\nUse this.");
  assert.match(skill.hash, /^[a-f0-9]{64}$/);
  await f.ui.handle("config_remove_skills", "demo");
  assert.deepEqual(f.store.global()?.data.skills, []);
  assert.equal(f.store.global()?.revision, 3);
});
test("memory remember and forget persist global defaults, bounded validated input", async () => {
  const f = fixture();
  await f.ui.handle("config_remember", "Keep responses concise");
  assert.equal(
    (f.store.global()?.data.defaults as any).memory[0].content,
    "Keep responses concise",
  );
  const id = (f.store.global()?.data.defaults as any).memory[0].id;
  await f.ui.handle("config_forget", id);
  assert.deepEqual((f.store.global()?.data.defaults as any).memory, []);
  await assert.rejects(f.ui.handle("config_remember", " "));
});
test("unknown callback and missing target cannot cause a revision", async () => {
  const f = fixture();
  assert.equal(await f.ui.handle("unknown"), false);
  await assert.rejects(f.ui.handle("config_toggle_mcps", "missing"));
  assert.equal(f.store.global()?.revision, 1);
});

test("pure Core mutations require exact skill hashes and never alter input", async () => {
  const { applyGlobalConfigMutation } = await import("../src/cloudflare/config-ui.js");
  const f = fixture(),
    original = f.store.global()!.data;
  await assert.rejects(
    applyGlobalConfigMutation(original, "skills.add", "demo", { content: "demo", hash: "bad" }),
    /skill_content_hash_mismatch/,
  );
  assert.deepEqual(original.skills, []);
  const content = "\n# Demo\n";
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  const next = await applyGlobalConfigMutation(original, "skills.add", "demo", {
    content,
    hash: digest,
  });
  assert.equal((next.skills as any[])[0].content, content);
  assert.deepEqual(original.skills, []);
});
test("pure MCP rename updates runtime, extension and action references together", async () => {
  const { applyGlobalConfigMutation } = await import("../src/cloudflare/config-ui.js");
  const f = fixture(),
    original = f.store.global()!.data;
  (original.configuration as any).extensions = [
    { id: "ext", resource: { kind: "mcp", serverName: "demo" } },
  ];
  original.actions = [
    { id: "ext.list", invocation: { kind: "mcp-tool", server: "demo", tool: "list" } },
  ];
  const next = await applyGlobalConfigMutation(original, "mcp.rename", "demo", {
    newName: "renamed",
  });
  assert.ok((next.configuration as any).runtime.mcp.renamed);
  assert.equal((next.configuration as any).runtime.mcp.demo, undefined);
  assert.equal((next.actions as any[])[0].invocation.server, "renamed");
  assert.equal((next.configuration as any).extensions[0].resource.serverName, "renamed");
  assert.ok((original.configuration as any).runtime.mcp.demo);
});
test("provider toggle uses upstream disabled_providers and plugin toggle removes runtime entry", async () => {
  const f = fixture();
  await f.ui.handle(
    "config_save_providers",
    JSON.stringify({
      id: "custom",
      baseURL: "https://example.com/v1",
      models: { demo: { name: "Demo" } },
    }),
  );
  await f.ui.handle("config_toggle_providers", "custom");
  assert.deepEqual((f.store.global()?.data.configuration as any).runtime.disabled_providers, [
    "custom",
  ]);
  await f.ui.handle("config_toggle_providers", "custom");
  assert.deepEqual((f.store.global()?.data.configuration as any).runtime.disabled_providers, []);
  await f.ui.handle("config_save_plugins", JSON.stringify({ specifier: "demo@1.2.3" }));
  await f.ui.handle("config_toggle_plugins", "demo@1.2.3");
  assert.deepEqual((f.store.global()?.data.configuration as any).runtime.plugin, []);
  await f.ui.handle("config_toggle_plugins", "demo@1.2.3");
  assert.deepEqual((f.store.global()?.data.configuration as any).runtime.plugin, ["demo@1.2.3"]);
});
test("provider references resolve declared capability without credential disclosure", async () => {
  const f = fixture(),
    state = f.store.global()!;
  f.store.setGlobal(
    {
      ...state.data,
      credentialReferences: [
        {
          id: "protected",
          extensionId: "model-provider:custom",
          credentialId: "api-key",
          configured: true,
        },
      ],
    },
    "refs",
    state.revision,
  );
  await f.ui.handle(
    "config_save_providers",
    JSON.stringify({
      id: "custom",
      baseURL: "https://example.com/v1",
      models: { demo: { name: "Demo" } },
      credentialRef: "protected",
    }),
  );
  assert.equal(
    (f.store.global()?.data.configuration as any).runtime.provider.custom.options.apiKey,
    "bot-credential-proxy:model-provider:custom:api-key",
  );
  await assert.rejects(
    f.ui.handle(
      "config_save_providers",
      JSON.stringify({
        id: "other",
        baseURL: "https://example.com/v1",
        models: { demo: { name: "Demo" } },
        credentialRef: "protected",
      }),
    ),
    /capability_mismatch/,
  );
});
test("Core skill create generates legacy-compatible YAML and inspected add uses contentHash", async () => {
  const { applyGlobalConfigMutation } = await import("../src/cloudflare/config-ui.js");
  const f = fixture(),
    data = f.store.global()!.data;
  const next = await applyGlobalConfigMutation(data, "skills.create", "demo", {
    description: 'A "quoted"\nsummary',
    body: " # Body ",
  });
  assert.equal(
    (next.skills as any[])[0].content,
    "---\nname: demo\ndescription: \"A 'quoted' summary\"\n---\n\n# Body\n",
  );
  const content = "# Imported";
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  const imported = await applyGlobalConfigMutation(data, "skills.add", "imported", {
    content,
    contentHash: digest,
  });
  assert.equal((imported.skills as any[])[0].content, content);
});
test("Core candidate action packs accept colon owner IDs and normalize exact records", async () => {
  const { applyGlobalConfigMutation } = await import("../src/cloudflare/config-ui.js");
  const f = fixture(),
    data = f.store.global()!.data;
  (data.configuration as any).extensions = [
    { id: "mcp:demo", name: "Demo", resource: { kind: "mcp", serverName: "demo" } },
  ];
  const next = await applyGlobalConfigMutation(data, "generated-actions.register", "mcp:demo", {
    actions: [
      {
        id: "demo.list",
        tool: "list",
        description: "List",
        invocation: { kind: "mcp-tool", server: "demo", tool: "list" },
      },
    ],
  });
  const action = (next.actions as any[])[0];
  assert.equal(action.extensionId, "mcp:demo");
  assert.equal(action.action, "list");
  assert.equal(action.category, "extension");
  assert.equal(action.risk, "read");
  assert.equal(action.userDisabled, false);
  assert.equal(action.enabled, true);
  await assert.rejects(
    applyGlobalConfigMutation(data, "generated-actions.register", "mcp:demo", {
      actions: [
        {
          id: "demo.list",
          tool: "list",
          description: "List",
          invocation: { kind: "mcp-tool", server: "other", tool: "list" },
        },
      ],
    }),
    /owner_mismatch/,
  );
});
test("custom commands validate Core schema and persist add edit toggle remove", async () => {
  const f = fixture();
  assert.equal(await f.ui.handle("commands"), true);
  await f.ui.handle(
    "config_save_commands",
    JSON.stringify({
      id: "review",
      template: "Review $ARGUMENTS",
      description: "Review changes",
      agent: "build",
      model: "custom/demo",
      variant: "fast",
      subtask: true,
    }),
  );
  assert.deepEqual((f.store.global()?.data.configuration as any).runtime.command.review, {
    template: "Review $ARGUMENTS",
    description: "Review changes",
    agent: "build",
    model: "custom/demo",
    variant: "fast",
    subtask: true,
  });
  await f.ui.handle(
    "config_save_commands",
    JSON.stringify({ id: "review", template: "Updated $ARGUMENTS" }),
  );
  assert.equal(
    (f.store.global()?.data.configuration as any).runtime.command.review.template,
    "Updated $ARGUMENTS",
  );
  await f.ui.handle("config_toggle_commands", "review");
  assert.deepEqual((f.store.global()?.data.configuration as any).runtime.command, {});
  await f.ui.handle("config_toggle_commands", "review");
  assert.equal(
    (f.store.global()?.data.configuration as any).runtime.command.review.template,
    "Updated $ARGUMENTS",
  );
  await f.ui.handle("config_remove_commands", "review");
  assert.deepEqual((f.store.global()?.data.configuration as any).runtime.command, {});
});
test("custom commands reject unknown fields wrong types and embedded credentials without a revision", async () => {
  const f = fixture();
  for (const bad of [
    { id: "test", template: "ok", subtask: "true" },
    { id: "test", template: "ok", env: { TOKEN: "bad" } },
    { id: "test", template: "Bearer SECRET" },
    { id: "test", template: "" },
    { id: "test", template: "ok", model: "invalid" },
  ])
    await assert.rejects(f.ui.handle("config_save_commands", JSON.stringify(bad)));
  assert.equal(f.store.global()?.revision, 1);
});

test("global streaming default toggles supported edit/off modes", async () => {
  const f = fixture();
  await f.ui.handle("config_default", "responseStreamingMode");
  assert.equal((f.store.global()!.data.defaults as any).topicDefaults.responseStreamingMode, "off");
  await f.ui.handle("config_default", "responseStreamingMode");
  assert.equal(
    (f.store.global()!.data.defaults as any).topicDefaults.responseStreamingMode,
    "edit",
  );
});

test("guided skill entry commits only after scoped confirmation and survives restart", async () => {
  const f = fixture();
  await f.ui.handle("config_add_skills");
  assert.equal(f.prompts.at(-1), "config_wizard_name");
  await f.ui.handle("config_wizard_name", "project-check");
  assert.equal(f.prompts.at(-1), "config_wizard_description");
  await f.ui.handle("config_wizard_description", "Use before changing a project.");
  assert.equal(f.prompts.at(-1), "config_wizard_content");
  await f.ui.handle("config_wizard_content", "# Project check\nInspect before changing files.");
  assert.deepEqual(f.store.global()!.data.skills, []);
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='config-draft:test'")][0]
      .data,
  );
  const restarted = new CloudConfigUi(f.context);
  await restarted.handle("config_wizard_confirm", draft.id);
  await restarted.handle("config_wizard_confirm", draft.id);
  assert.equal(f.store.global()!.revision, 2);
  assert.equal((f.store.global()!.data.skills as any[])[0].name, "project-check");
  assert.match(
    (f.store.global()!.data.skills as any[])[0].content,
    /^---\nname: project-check\ndescription: "Use before changing a project\."\n---/,
  );
});

test("guided remote MCP entry rejects credential URLs and retains correction step", async () => {
  const f = fixture();
  await f.ui.handle("config_add_mcps");
  await f.ui.handle("config_wizard_name", "docs");
  await f.ui.handle("config_wizard_content", "https://user:secret@example.com/mcp");
  assert.equal(f.store.global()!.revision, 1);
  assert.equal(f.prompts.at(-1), "config_wizard_content");
  assert.ok(!f.messages.join("").includes("user:secret"));
  await f.ui.handle("config_wizard_content", "https://example.com/mcp");
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='config-draft:test'")][0]
      .data,
  );
  await f.ui.handle("config_wizard_confirm", draft.id);
  assert.equal(
    (f.store.global()!.data.configuration as any).runtime.mcp.docs.url,
    "https://example.com/mcp",
  );
});

test("advanced MCP JSON entry remains available for governed local runtime configuration", async () => {
  const f = fixture();
  assert.equal(await f.ui.handle("config_json_mcps"), true);
  assert.equal(f.prompts.at(-1), "config_save_mcps");
});

test("configuration wizard rejects stale preview after canonical revision changes", async () => {
  const f = fixture();
  await f.ui.handle("config_add_commands");
  await f.ui.handle("config_wizard_name", "inspect");
  await f.ui.handle("config_wizard_content", "Inspect the project before changing files.");
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='config-draft:test'")][0]
      .data,
  );
  await f.ui.handle("config_remember", "Preserve deployment safety.");
  await assert.rejects(
    f.ui.handle("config_wizard_confirm", draft.id),
    /configuration_revision_changed/,
  );
  assert.equal((f.store.global()!.data.configuration as any).runtime.command, undefined);
});

test("rate-limited configuration confirmation cannot repeat canonical mutation", async () => {
  const f = fixture();
  await f.ui.handle("config_add_commands");
  await f.ui.handle("config_wizard_name", "inspect");
  await f.ui.handle("config_wizard_content", "Inspect project status.");
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='config-draft:test'")][0]
      .data,
  );
  const ui = new CloudConfigUi({
    ...f.context,
    notice: async () => {
      throw new Error("telegram_429");
    },
  });
  await assert.rejects(ui.handle("config_wizard_confirm", draft.id), /telegram_429/);
  assert.equal(f.store.global()!.revision, 2);
  assert.equal(await ui.handle("config_wizard_confirm", draft.id), true);
  assert.equal(f.store.global()!.revision, 2);
});

test("empty guided skill body reopens input instead of losing the form", async () => {
  const f = fixture();
  await f.ui.handle("config_add_skills");
  await f.ui.handle("config_wizard_name", "project-check");
  await f.ui.handle("config_wizard_description", "Inspect before editing.");
  await f.ui.handle("config_wizard_content", "");
  assert.equal(f.prompts.at(-1), "config_wizard_content");
  assert.equal(f.store.global()!.revision, 1);
});

test("each accepted configuration step renews the deadline for its next input", async (t) => {
  const f = fixture();
  const original = Date.now;
  let clock = original();
  Date.now = () => clock;
  t.after(() => {
    Date.now = original;
  });
  await f.ui.handle("config_add_commands");
  clock += 240000;
  await f.ui.handle("config_wizard_name", "inspect");
  clock += 120000;
  await f.ui.handle("config_wizard_content", "Inspect project state.");
  const draft = JSON.parse(
    [...f.sql.exec<{ data: string }>("SELECT data FROM ui_state WHERE key='config-draft:test'")][0]
      .data,
  );
  assert.equal(draft.stage, "confirm");
  assert.equal(draft.expires, clock + 300000);
});
