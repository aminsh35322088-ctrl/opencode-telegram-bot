import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeBindings, type NodeBinding } from "../src/control-plane/node-bindings.js";
import { installSecureNodeTransport } from "../src/control-plane/topic-node-client.js";
import { getRemoteRunId, invokeTopicSdk } from "../src/control-plane/topic-sdk-adapter.js";
import { hasRemoteTopicRunEvents, stopTopicEventBus } from "../src/opencode/topic-event-bus.js";

const binding: NodeBinding = { nodeId: "compact-node", generation: 1, chatId: -100, threadId: 2, sessionId: "compact-owned", currentRevision: 2, status: "ready", createdAt: "now", updatedAt: "now" };
nodeBindings.find = async () => structuredClone(binding);
const topic = { chatId: -100, threadId: 2, sessionId: binding.sessionId, directory: "/logical/compact" };
const parameters = { sessionID: binding.sessionId, directory: topic.directory, providerID: "provider", modelID: "model" };
const calls: string[] = [];
let controller: AbortController;
let streamClosed = false;
let teardown: Promise<void> | undefined;
installSecureNodeTransport({
  request: async (_binding, envelope) => {
    calls.push(envelope.operation);
    if (envelope.operation === "session.compact") queueMicrotask(() => controller.abort(new Error("compaction cancelled")));
    return { ok: true, result: true };
  },
  stream: async function* (_binding, _envelope, options) {
    options?.onReady?.();
    try {
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      if (teardown) await teardown;
    } finally { streamClosed = true; }
  },
});

test("remote compaction cancellation after acknowledgement closes its stream and releases run ownership", async () => {
  controller = new AbortController();
  streamClosed = false;
  calls.length = 0;
  const operation = invokeTopicSdk(topic, "session.summarize", [parameters, { signal: controller.signal }]);
  try {
    const outcome = await Promise.race([operation.then(() => "resolved", () => "rejected"), new Promise<string>(resolve => setTimeout(() => resolve("still-pending"), 150))]);
    assert.equal(outcome, "rejected", "a cancelled acknowledged compaction must settle");
    assert.equal(streamClosed, true);
    assert.equal(hasRemoteTopicRunEvents(binding.sessionId!), false);
    assert.equal(getRemoteRunId(binding.sessionId!), undefined);
  } finally { stopTopicEventBus(); await operation.catch(() => {}); }
});

test("pre-aborted remote compaction sends no prepare or compact request", async () => {
  controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  calls.length = 0;
  const operation = invokeTopicSdk(topic, "session.summarize", [parameters, { signal: controller.signal }]);
  try {
    const outcome = await Promise.race([operation.then(() => "resolved", () => "rejected"), new Promise<string>(resolve => setTimeout(() => resolve("still-pending"), 150))]);
    assert.equal(outcome, "rejected");
    assert.deepEqual(calls, []);
  } finally { stopTopicEventBus(); await operation.catch(() => {}); }
});


test("cancelled compaction retains ownership until its stream teardown completes", async () => {
  controller = new AbortController();
  streamClosed = false;
  let finishTeardown!: () => void;
  teardown = new Promise<void>(resolve => { finishTeardown = resolve; });
  const operation = invokeTopicSdk(topic, "session.summarize", [parameters, { signal: controller.signal }]);
  const outcome = operation.then(() => "resolved", () => "rejected");
  try {
    const beforeTeardown = await Promise.race([outcome, new Promise<string>(resolve => setTimeout(() => resolve("joining"), 30))]);
    assert.equal(beforeTeardown, "joining", "cancellation must join teardown before releasing ownership");
    finishTeardown();
    assert.equal(await outcome, "rejected");
    assert.equal(streamClosed, true);
    assert.equal(hasRemoteTopicRunEvents(binding.sessionId!), false);
    assert.equal(getRemoteRunId(binding.sessionId!), undefined);
  } finally { finishTeardown(); teardown = undefined; stopTopicEventBus(); await operation.catch(() => {}); }
});
