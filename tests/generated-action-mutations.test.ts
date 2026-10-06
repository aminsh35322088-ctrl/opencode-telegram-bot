import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { updateAppState } from "../src/app/stores/app-state-store.js";
import {
  registerGeneratedActionPack,
  removeGeneratedActionsForExtension,
  listGeneratedActions,
} from "../src/app/services/generated-action-store.js";
import {
  prepareGlobalMutation,
  bindGlobalMutationQuestion,
  handleApprovedGlobalQuestion,
  runTrustedTelegramGlobalMutation,
  commitPreparedGlobalMutation,
} from "../src/control-plane/mutations.js";
import { readGlobalSnapshot } from "../src/control-plane/global-state.js";
test("generated packs require exact approval and publish fixed arguments while preserving disabled choices", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "generated-mutations-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  const actor = { nodeId: "node", generation: 1, chatId: 1, threadId: 2, sessionId: "session" };
  const extension = {
    id: "skill:example",
    name: "example",
    kind: "skill",
    source: "local",
    authType: "none",
    credentialSchemas: [],
    resource: { kind: "skill", skillName: "example" },
    managed: true,
    createdAt: "now",
    updatedAt: "now",
  };
  const actions = [
    {
      id: "example.load",
      tool: "skill",
      description: "Load example",
      invocation: { kind: "native-tool", tool: "skill", arguments: { name: "example" } },
    },
  ];
  try {
    await updateAppState({ extensions: { version: 1, records: { [extension.id]: extension } } });
    await assert.rejects(
      registerGeneratedActionPack(extension.id, actions as never),
      /requires an approved/,
    );
    await assert.rejects(removeGeneratedActionsForExtension(extension.id), /requires an approved/);
    let counter = 0;
    const commit = async (type: string, config: Record<string, unknown>) => {
      const prepared = await prepareGlobalMutation(actor, { type, resource: extension.id, config });
      const requestId = "q" + ++counter;
      await bindGlobalMutationQuestion(actor, requestId, [prepared.question]);
      await runTrustedTelegramGlobalMutation("question.approve", requestId, () =>
        handleApprovedGlobalQuestion({
          actor,
          requestId,
          questions: [prepared.question],
          answers: [["Approve"]],
        }),
      );
      await assert.rejects(
        commitPreparedGlobalMutation(actor, prepared.approvalId, {
          ...prepared.preview,
          config: { ...prepared.preview.config, changed: true },
        }),
      );
      return commitPreparedGlobalMutation(actor, prepared.approvalId, prepared.preview);
    };
    const before = await readGlobalSnapshot();
    await commit("generated-actions.register", { actions });
    const next = await readGlobalSnapshot();
    assert.equal(next.revision, before.revision + 1);
    assert.deepEqual((next.actions[0] as any).invocation.arguments, { name: "example" });
    const { setGeneratedActionEnabled } =
      await import("../src/app/services/generated-action-store.js");
    await runTrustedTelegramGlobalMutation("generated-actions.toggle", "example.load", () =>
      setGeneratedActionEnabled("example.load", false),
    );
    await commit("generated-actions.update", { actions });
    assert.equal((await listGeneratedActions())[0]?.enabled, false);
    await assert.rejects(
      prepareGlobalMutation(actor, {
        type: "generated-actions.update",
        resource: extension.id,
        config: { actions: [{ ...actions[0], id: "other.load" }] },
      }),
      /namespace/,
    );
    await assert.rejects(
      prepareGlobalMutation(actor, {
        type: "generated-actions.update",
        resource: extension.id,
        config: {
          actions: [
            {
              ...actions[0],
              invocation: { kind: "native-tool", tool: "skill", arguments: { token: "secret" } },
            },
          ],
        },
      }),
      /argument/,
    );
    await commit("generated-actions.remove", {});
    assert.equal((await listGeneratedActions()).length, 0);
  } finally {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(home, { recursive: true, force: true });
  }
});
test("owning MCP mutations keep actual target risk and cannot write another extension pack", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "generated-parent-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  try {
    const make = (name: string) => ({
      id: "mcp:" + name,
      name,
      kind: "mcp",
      source: "source",
      authType: "none",
      credentialSchemas: [],
      resource: { kind: "mcp", serverName: name, projectDirectory: "/project" },
      managed: true,
      createdAt: "now",
      updatedAt: "now",
    });
    await updateAppState({
      extensions: { version: 1, records: { "mcp:one": make("one"), "mcp:two": make("two") } },
    });
    const actions = [
      {
        id: "one.safe",
        tool: "mcp",
        action: "call",
        description: "Tool",
        invocation: { kind: "mcp-tool" as const, server: "one", tool: "delete_database" },
      },
    ];
    await runTrustedTelegramGlobalMutation("mcp.sync", "one", () =>
      registerGeneratedActionPack("mcp:one", actions),
    );
    assert.equal((await listGeneratedActions())[0]?.risk, "destructive");
    await assert.rejects(
      runTrustedTelegramGlobalMutation("mcp.sync", "two", () =>
        registerGeneratedActionPack("mcp:one", actions),
      ),
      /requires an approved/,
    );
    await assert.rejects(
      runTrustedTelegramGlobalMutation("generated-actions.register", "mcp:one", () =>
        registerGeneratedActionPack("mcp:one", [
          { ...actions[0], invocation: { ...actions[0].invocation, server: "two" } },
        ]),
      ),
      /owning/,
    );
    const { removeStoredExtension } = await import("../src/app/services/extension-store.js");
    await runTrustedTelegramGlobalMutation("extensions.remove", "mcp:one", async () => {
      await removeStoredExtension("mcp:one");
      await removeGeneratedActionsForExtension("mcp:one");
    });
    assert.equal((await listGeneratedActions()).length, 0);
  } finally {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(home, { recursive: true, force: true });
  }
});
test("distributed cutover preserves legacy state and default startup still removes retired packs", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "generated-cleanup-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  try {
    const { readAppState } = await import("../src/app/stores/app-state-store.js");
    const { cleanupLegacyUserConfiguration } =
      await import("../src/app/services/persistent-state-registry.js");
    const extension = {
      id: "integration:retired",
      name: "retired",
      kind: "integration",
      source: "source",
      authType: "none",
      credentialSchemas: [],
      resource: { kind: "integration", adapter: "retired" },
      managed: true,
      createdAt: "now",
      updatedAt: "now",
    };
    await updateAppState({
      extensions: { version: 1, records: { [extension.id]: extension } },
      credentialVault: { opaque: "preserved" },
      freeModelSources: { legacy: true },
    });
    await runTrustedTelegramGlobalMutation("generated-actions.register", extension.id, () =>
      registerGeneratedActionPack(extension.id, [
        {
          id: "retired.get",
          tool: "read",
          description: "Read",
          invocation: { kind: "native-tool", tool: "read" },
        },
      ]),
    );
    const before = await readAppState();
    process.env.CONTROL_APPLICATION_IPC = "1";
    await cleanupLegacyUserConfiguration();
    assert.deepEqual(await readAppState(), before);
    delete process.env.CONTROL_APPLICATION_IPC;
    await cleanupLegacyUserConfiguration();
    assert.equal((await listGeneratedActions()).length, 0);
    const { getStoredExtension } = await import("../src/app/services/extension-store.js");
    assert.equal(await getStoredExtension(extension.id), null);
  } finally {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    delete process.env.CONTROL_APPLICATION_IPC;
    await rm(home, { recursive: true, force: true });
  }
});
