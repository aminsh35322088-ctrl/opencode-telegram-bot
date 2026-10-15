import assert from "node:assert/strict";
import { after, test, mock } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const home = await mkdtemp(path.join(tmpdir(), "distributed-authority-"));
process.env.OPENCODE_TELEGRAM_HOME = home;
process.env.TELEGRAM_BOT_TOKEN = "12345:test-token";
process.env.TELEGRAM_USER_ID = "42";
process.env.CONTROL_APPLICATION_IPC = "1";
const core = await import("../src/core/native-core-service.js");
const { nodeBindings } = await import("../src/control-plane/node-bindings.js");
const { runInTopicRuntimeContext } = await import("../src/app/services/topic-runtime-context.js");
const { installSecureNodeTransport } = await import("../src/control-plane/topic-node-client.js");
const { stopTopicEventBus } = await import("../src/opencode/topic-event-bus.js");
const { saveTelegramTopicBinding } = await import("../src/app/services/telegram-topic-store.js");
const topic = {
  chatId: 42,
  threadId: 7,
  sessionId: "remote-session",
  directory: path.join(home, "topic"),
};
let worker = {
  nodeId: "remote-node",
  generation: 4,
  chatId: 42,
  threadId: 7,
  sessionId: topic.sessionId,
  currentRevision: 1,
  status: "ready" as "ready" | "retiring",
  createdAt: "now",
  updatedAt: "now",
};
nodeBindings.find = async () => ({ ...worker });
nodeBindings.list = async () => [{ ...worker }];
const calls: Array<{ operation: string; payload: unknown }> = [];
let rejectStop = false;
let nativeStatus: unknown = null;
let statusGate: Promise<void> | null = null;
let statusStarted: (() => void) | null = null;
installSecureNodeTransport({
  request: async (_binding, envelope) => {
    calls.push({ operation: envelope.operation, payload: envelope.payload });
    if (rejectStop && envelope.operation === "stop") throw new Error("synthetic stop failure");
    if (envelope.operation === "status") {
      statusStarted?.();
      await statusGate;
    }
    const result =
      envelope.operation === "status"
        ? nativeStatus
        : envelope.operation === "session.status"
          ? {}
          : ["session.messages", "question.list", "permission.list"].includes(envelope.operation)
            ? []
            : true;
    return { ok: true, result };
  },
  stream: async function* (_binding, _envelope, options) {
    options?.onReady?.();
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  },
});
after(async () => {
  stopTopicEventBus();
  await core.shutdownNativeCore();
  await rm(home, { recursive: true, force: true });
});

test("distributed binding registration routes a Topic without initializing local Core", async () => {
  await core.registerCoreTopicBinding(topic);
  assert.equal(core.getNativeCore(), null);
  assert.equal(core.resolveCoreTopicBinding(42, 7)?.sessionId, topic.sessionId);
  assert.equal(core.resolveCoreSessionRoute(topic.sessionId).normalizedDirectory, topic.directory);
});

test("distributed prompt dispatch reaches authenticated Worker RPC with the admitted run identity", async () => {
  await runInTopicRuntimeContext(topic, async () => {
    const owner = core.captureCurrentCoreBindingOwner();
    assert.equal(owner.sessionId, topic.sessionId);
    const run = await core.beginCoreRunForSession(topic.sessionId, topic.directory);
    await assert.rejects(
      core.beginCoreRunForSession(topic.sessionId, topic.directory),
      /active run/,
    );
    calls.length = 0;
    await core.dispatchCorePrompt(run, {
      sessionID: topic.sessionId,
      directory: topic.directory,
      parts: [{ type: "text", text: "hello" }],
    });
    assert.deepEqual(
      calls.map((call) => call.operation),
      ["run.prepare", "run"],
    );
    for (const call of calls) assert.equal((call.payload as { runId: string }).runId, run.runId);
    stopTopicEventBus();
    await new Promise((resolve) => setImmediate(resolve));
    core.finishCoreRunForSession(topic.sessionId);
  });
});

test("distributed dispatch rejects a replaced Worker before any RPC", async () => {
  await runInTopicRuntimeContext(topic, async () => {
    const run = await core.beginCoreRunForSession(topic.sessionId, topic.directory);
    worker = { ...worker, generation: worker.generation + 1 };
    calls.length = 0;
    await assert.rejects(
      core.dispatchCorePrompt(run, {
        sessionID: topic.sessionId,
        directory: topic.directory,
        parts: [{ type: "text", text: "stale" }],
      }),
      /changed|stale|fenced/i,
    );
    assert.deepEqual(calls, []);
    core.finishCoreRunForSession(topic.sessionId);
    await core.registerCoreTopicBinding(topic);
  });
});

test("distributed auth admits real Topic message and Reply Keyboard text", async () => {
  const { authMiddleware } = await import("../src/bot/middleware/auth.js");
  const { attachManager } = await import("../src/app/managers/attach-manager.js");
  const original = attachManager.isAttachedSession;
  attachManager.isAttachedSession = () => true;
  await saveTelegramTopicBinding({ ...topic, title: "Remote", createdAt: "now", updatedAt: "now" });
  try {
    for (const text of ["hello", "⚙️ Settings"]) {
      let reached = false;
      const ctx = {
        from: { id: 42 },
        chat: { id: 42 },
        message: {
          chat: { id: 42 },
          message_id: 1,
          message_thread_id: 7,
          is_topic_message: true,
          text,
        },
        api: {},
      };
      await authMiddleware(ctx as never, async () => {
        reached = true;
        assert.equal(core.captureCurrentCoreBindingOwner().sessionId, topic.sessionId);
      });
      assert.equal(reached, true, `middleware dropped ${text}`);
    }
  } finally {
    attachManager.isAttachedSession = original;
  }
});

test("auth restores the actual distributed attach path before admitting Topic input", async () => {
  const { authMiddleware } = await import("../src/bot/middleware/auth.js");
  const { setTelegramTopicRuntimeDependencies } =
    await import("../src/bot/services/telegram-topic-runtime.js");
  let subscribed = false;
  setTelegramTopicRuntimeDependencies({
    ensureEventSubscription: async (directory) => {
      assert.equal(directory, topic.directory);
      subscribed = true;
    },
    retireSessionRuntime: () => {},
  });
  calls.length = 0;
  let reached = false;
  const ctx = {
    from: { id: 42 },
    chat: { id: 42 },
    message: {
      chat: { id: 42 },
      message_id: 2,
      message_thread_id: 7,
      is_topic_message: true,
      text: "hello after restart",
    },
    api: {},
  };
  await authMiddleware(ctx as never, async () => {
    reached = true;
  });
  assert.equal(reached, true);
  assert.equal(subscribed, true);
  assert.ok(calls.some((call) => call.operation === "session.status"));
  assert.ok(calls.some((call) => call.operation === "question.list"));
  assert.equal(core.getNativeCore(), null);
});

test("retiring Worker fails admission and unknown Topic cannot borrow another session", async () => {
  worker = { ...worker, status: "retiring" };
  await runInTopicRuntimeContext(topic, async () => {
    await assert.rejects(
      core.beginCoreRunForSession(topic.sessionId, topic.directory),
      /ready|changed|owner/i,
    );
  });
  worker = { ...worker, status: "ready" };
  await runInTopicRuntimeContext({ ...topic, threadId: 8 }, async () => {
    await assert.rejects(
      core.beginCoreRunForSession(topic.sessionId, topic.directory),
      /exact bound/,
    );
  });
});

test("distributed startup hydrates existing Topics and recovers only the signed active run", async () => {
  stopTopicEventBus();
  await core.shutdownNativeCore();
  await core.initializeDistributedTopicAuthority([topic]);
  assert.equal(core.getNativeCore(), null);
  await runInTopicRuntimeContext(topic, async () => {
    const run = await core.restoreRemoteCoreRun(
      topic.sessionId,
      topic.directory,
      "worker-recovered-run",
    );
    assert.equal(core.currentCoreRun(run.bindingId)?.runId, "worker-recovered-run");
    await assert.rejects(
      core.restoreRemoteCoreRun(topic.sessionId, topic.directory, "different-run"),
      /differs/,
    );
    core.finishCoreRunForSession(topic.sessionId);
  });
});

test("owner dispatch restores exact Topic scope outside interactive middleware", async () => {
  const { getTopicRuntimeContext } = await import("../src/app/services/topic-runtime-context.js");
  const owner = runInTopicRuntimeContext(topic, () => core.captureCurrentCoreBindingOwner());
  const run = await core.beginCoreRunForOwner(owner, "scheduled");
  try {
    await core.dispatchCoreOwnedTask(run, "scheduled", async () => {
      assert.deepEqual(getTopicRuntimeContext(), topic);
    });
    await assert.rejects(
      core.dispatchCoreOwnedTask(run, "late", async () => {
        worker = { ...worker, generation: worker.generation + 1 };
        return true;
      }),
      /changed|fenced/i,
    );
  } finally {
    core.finishCoreRun(run);
    await core.registerCoreTopicBinding(topic);
  }
});

test("route rotation cannot revive a captured owner after restart", async () => {
  const owner = runInTopicRuntimeContext(topic, () => core.captureCurrentCoreBindingOwner());
  await core.rotateCoreTopicBinding(topic, {
    sessionId: topic.sessionId,
    directory: topic.directory + "-other",
  });
  await core.rotateCoreTopicBinding({ ...topic, directory: topic.directory + "-other" }, topic);
  await core.shutdownNativeCore();
  await core.initializeDistributedTopicAuthority([topic]);
  await assert.rejects(core.beginCoreRunForOwner(owner, "stale-scheduled"), /Stale/);
});

test("captured remote output rejects Worker replacement", async () => {
  const { createCoreSessionApi } = await import("../src/bot/services/core-session-api.js");
  let sent = 0;
  const api = {
    sendMessage: async () => {
      sent++;
      return {};
    },
  };
  const scoped = createCoreSessionApi(api as never, topic.sessionId);
  worker = { ...worker, generation: worker.generation + 1 };
  await assert.rejects(scoped.sendMessage(42, "late"), /changed|stale|fenced/i);
  assert.equal(sent, 0);
  await core.registerCoreTopicBinding(topic);
});

test("timed out remote tasks stop exactly their Worker run and uncertain cleanup stays fenced", async () => {
  await runInTopicRuntimeContext(topic, async () => {
    for (const failedStop of [false, true]) {
      const run = await core.beginCoreRunForSession(topic.sessionId, topic.directory);
      calls.length = 0;
      rejectStop = failedStop;
      try {
        await assert.rejects(
          core.dispatchCoreOwnedTask(
            run,
            "timeout",
            async ({ signal }) => {
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            },
            { timeoutMs: 10 },
          ),
          /deadline|timed out|timeout/i,
        );
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], { operation: "stop", payload: { runId: run.runId } });
      } finally {
        rejectStop = false;
        core.finishCoreRunForSession(topic.sessionId);
      }
    }
    worker = { ...worker, status: "retiring" };
    await core.refreshCoreTopicBinding(topic);
    worker = { ...worker, status: "ready" };
    await core.refreshCoreTopicBinding(topic);
    await assert.rejects(
      core.beginCoreRunForSession(topic.sessionId, topic.directory),
      /cleanup is uncertain/,
    );
    const now = Date.now();
    const clock = mock.method(Date, "now", () => now + 31_000);
    try {
      nativeStatus = { continuation: "live", externalRunId: "still-active" };
      await assert.rejects(
        core.beginCoreRunForSession(topic.sessionId, topic.directory),
        /cleanup is uncertain/,
      );
      nativeStatus = null;
      await assert.rejects(
        core.beginCoreRunForSession(topic.sessionId, topic.directory),
        /cleanup is uncertain/,
      );
      nativeStatus = { continuation: "pending", externalRunId: "still-staging" };
      await assert.rejects(
        core.beginCoreRunForSession(topic.sessionId, topic.directory),
        /cleanup is uncertain/,
      );
      nativeStatus = { continuation: "idle", externalRunId: null };
      calls.length = 0;
      const recovered = await core.beginCoreRunForSession(topic.sessionId, topic.directory);
      assert.deepEqual(
        calls.map((call) => call.operation),
        ["status"],
      );
      core.finishCoreRunForSession(topic.sessionId);
      assert.ok(recovered.runId);
    } finally {
      nativeStatus = null;
      clock.mock.restore();
    }
  });
});

test("fresh uncertainty during a signed status read cannot be erased by older idle evidence", async () => {
  const { RemoteTopicAuthority } = await import("../src/control-plane/remote-topic-authority.js");
  const authority = new RemoteTopicAuthority();
  const identity = core.resolveCoreTopicBinding(topic.chatId, topic.threadId)!;
  await authority.registerBinding(identity);
  const run = await authority.beginRun(identity.bindingId);
  let now = Date.now();
  const clock = mock.method(Date, "now", () => now);
  rejectStop = true;
  let release!: () => void;
  try {
    await assert.rejects(
      authority.dispatchTask(run, "first", async () => {
        throw new Error("first failure");
      }),
      /first failure/,
    );
    now += 31_000;
    statusGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      statusStarted = resolve;
    });
    nativeStatus = { continuation: "idle", externalRunId: null };
    const admission = authority.modelAllowed(
      { kind: "topic", botId: identity.botId, chatId: topic.chatId, threadId: topic.threadId },
      "prompt",
    );
    const denied = assert.rejects(admission, /cleanup is uncertain/);
    await started;
    now++;
    await assert.rejects(
      authority.dispatchTask(run, "second", async () => {
        throw new Error("new failure");
      }),
      /new failure/,
    );
    release();
    await denied;
  } finally {
    release?.();
    statusGate = null;
    statusStarted = null;
    nativeStatus = null;
    rejectStop = false;
    clock.mock.restore();
    authority.shutdown();
  }
});

test("distributed Telegram output remains scoped and stops after Topic deletion", async () => {
  const { createCoreSessionApi } = await import("../src/bot/services/core-session-api.js");
  const { removeTelegramTopicBinding } =
    await import("../src/app/services/telegram-topic-store.js");
  const sent: unknown[][] = [];
  const api = {
    sendMessage: async (...args: unknown[]) => {
      sent.push(args);
      return {};
    },
  };
  const scoped = createCoreSessionApi(api as never, topic.sessionId);
  await scoped.sendMessage(42, "reply");
  assert.deepEqual(sent[0], [42, "reply", { message_thread_id: 7 }]);
  await assert.rejects(scoped.sendMessage(43, "wrong chat"), /chat differs/);
  await assert.rejects(
    scoped.sendMessage(42, "wrong topic", { message_thread_id: 8 }),
    /thread differs/,
  );
  await removeTelegramTopicBinding(42, topic.sessionId);
  assert.equal(core.resolveCoreTopicBinding(42, 7), null);
  await assert.rejects(scoped.sendMessage(42, "late reply"), /binding|Topic|route/i);
  assert.equal(sent.length, 1);
});
