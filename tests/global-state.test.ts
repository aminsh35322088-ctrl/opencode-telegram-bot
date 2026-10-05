import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readGlobalSnapshot,
  commitGlobalMutation,
  canonicalJson,
} from "../src/control-plane/global-state.js";
import { updateAppState } from "../src/app/stores/app-state-store.js";

test("global snapshots serialize mutations, exclude secrets and preserve no-op revisions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "global-state-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  try {
    const initial = await readGlobalSnapshot();
    const input = {
      type: "settings",
      resource: "global",
      actorTopicId: "1",
      sessionId: "s",
      configHash: "h",
    };
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        commitGlobalMutation(input, () => updateAppState({ settings: { language: String(i) } })),
      ),
    );
    const next = await readGlobalSnapshot();
    assert.equal(next.revision, initial.revision + 8);
    await updateAppState({
      settings: { language: "7", apiKey: "SECRET", nested: { token: "SECRET" } },
      credentialVault: { secret: "SECRET" },
      mcpCredentials: { secret: "SECRET" },
    });
    assert.equal((await readGlobalSnapshot()).revision, next.revision);
    assert.ok(!JSON.stringify(await readGlobalSnapshot()).includes("SECRET"));
    let calls = 0;
    await commitGlobalMutation({ ...input, approvalId: "one" }, async () => {
      calls++;
      await updateAppState({ settings: { language: "en" } });
    });
    await commitGlobalMutation({ ...input, approvalId: "one" }, async () => {
      calls++;
    });
    assert.equal(calls, 1);
    const directory = path.join(home, ".config", "opencode", "skills", "example");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), "hello");
    const skills = await readGlobalSnapshot();
    assert.equal(skills.skills[0]?.content, "hello");
    assert.match(skills.skills[0]!.hash, /^[a-f0-9]{64}$/);
    assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  } finally {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test("failed mutation does not commit staged state or receipt", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "global-rollback-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  try {
    const before = await readGlobalSnapshot();
    await assert.rejects(
      commitGlobalMutation(
        {
          type: "settings",
          resource: "global",
          actorTopicId: "1",
          sessionId: "s",
          configHash: "h",
          approvalId: "failed",
        },
        async () => {
          await updateAppState({ settings: { language: "ru" } });
          throw new Error("failed");
        },
      ),
      /failed/,
    );
    assert.deepEqual(await readGlobalSnapshot(), before);
  } finally {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test("unusable primary and backup fail closed instead of overwriting state", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "global-corrupt-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  try {
    await writeFile(path.join(home, "app-state.json"), "broken");
    await writeFile(path.join(home, "app-state.json.bak"), "broken");
    await assert.rejects(readGlobalSnapshot(), /Cannot read app state/);
  } finally {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test("bootstrap stays stable and journal changes cannot downgrade or revise Global", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "global-bootstrap-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  try {
    const initial = await readGlobalSnapshot();
    assert.equal(initial.revision, 0);
    assert.deepEqual(await readGlobalSnapshot(), initial);
    await updateAppState({
      globalMutationApprovals: { pending: { config: { apiKey: "SECRET" } } },
      topicRuntime: { selectedModel: "topic-only" },
    });
    assert.deepEqual(await readGlobalSnapshot(), initial);
    await updateAppState({ settings: { language: "en" } });
    const next = await readGlobalSnapshot();
    await updateAppState({ globalSnapshot: initial });
    assert.deepEqual(await readGlobalSnapshot(), next);
  } finally {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime configuration projects valid OpenCode schemas and strips transport secrets", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "global-runtime-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  try {
    await updateAppState({
      mcpServers: {
        records: {
          one: {
            name: "docs",
            config: {
              type: "remote",
              url: "https://user:SECRET@example.com/mcp?key=SECRET",
              headers: { Authorization: "SECRET" },
              enabled: true,
            },
          },
          two: {
            name: "local",
            config: {
              type: "local",
              command: ["node", "server.js", "--port", "8080"],
              environment: { KEY: "SECRET" },
            },
          },
          bad: {
            name: "bad",
            config: { type: "local", command: ["node", "server.js", "--api-key", "SECRET"] },
          },
        },
      },
      extensions: {
        records: { p: { resource: { kind: "plugin", specifier: "@example/plugin@1.2.3" } } },
      },
      customProviders: {
        providers: [
          {
            id: "custom",
            name: "Custom",
            baseURL: "https://user:SECRET@example.com/v1?token=SECRET",
            apiKey: "SECRET",
            models: [{ id: "model-a", name: "Model A", toolCall: true, toolCallVerified: false }],
          },
        ],
      },
    });
    const snapshot = await readGlobalSnapshot();
    const runtime = snapshot.configuration.runtime as Record<string, any>;
    assert.equal(runtime.mcp.docs.url, "https://example.com/mcp");
    assert.deepEqual(runtime.mcp.local.command, ["node", "server.js", "--port", "8080"]);
    assert.equal(runtime.mcp.bad, undefined);
    assert.deepEqual(runtime.plugin, ["@example/plugin@1.2.3"]);
    assert.equal(runtime.provider.custom.options.baseURL, "https://example.com/v1");
    assert.equal(runtime.provider.custom.models["model-a"].tool_call, false);
    assert.ok(!JSON.stringify(snapshot).includes("SECRET"));
    assert.equal(runtime.settings, undefined);
  } finally {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(home, { recursive: true, force: true });
  }
});

test("public cached catalogs join Global runtime and model API without local Core", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "global-public-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  process.env.DISTRIBUTED_CONTROL_ENABLED="1";
  try {
    await writeFile(
      path.join(home, "free-llm-catalog-cache.json"),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-01-01",
        providers: [
          {
            id: "public",
            name: "Public",
            status: "verified",
            integration: "direct-openai",
            enabledByDefault: true,
            baseURL: "https://public.example/v1",
            auth: { mode: "none", userCredentialRequired: false },
            models: [
              { id: "p-model", name: "Public Model", toolCall: true, context: 32000, output: 4000 },
            ],
          },
        ],
      }),
    );
    const snapshot = await readGlobalSnapshot();
    const runtime = snapshot.configuration.runtime as Record<string, any>;
    assert.equal(runtime.provider["free-public"].models["p-model"].limit.context, 32000);
    const catalog = snapshot.catalog as Record<string, any>;
    assert.ok(
      catalog.entries.some(
        (entry: any) => entry.providerID === "free-public" && entry.modelID === "p-model",
      ),
    );
    const { listUnifiedModelCatalog } =
      await import("../src/app/services/unified-model-catalog-service.js");
    assert.ok(
      (await listUnifiedModelCatalog({ force: true })).some(
        (entry) => entry.providerID === "free-public",
      ),
    );
  } finally {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    delete process.env.DISTRIBUTED_CONTROL_ENABLED;
    await rm(home, { recursive: true, force: true });
  }
});
