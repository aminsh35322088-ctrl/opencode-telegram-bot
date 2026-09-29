import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const mocked = vi.hoisted(() => ({
  resolveCoreTopicBinding: vi.fn(),
  isCurrentCoreSessionRoute: vi.fn(),
  sendDocument: vi.fn(),
}));

vi.mock("../../../src/core/native-core-service.js", () => ({
  resolveCoreTopicBinding: mocked.resolveCoreTopicBinding,
  isCurrentCoreSessionRoute: mocked.isCurrentCoreSessionRoute,
}));
vi.mock("../../../src/bot/services/core-session-api.js", () => ({
  createCoreSessionApi: (_api: unknown, sessionId: string) => ({
    sendDocument: (chatId: number, file: unknown, options: Record<string, unknown>) =>
      mocked.sendDocument(chatId, file, {
        ...options,
        message_thread_id: sessionId === "b" ? 22 : 11,
      }),
  }),
}));
import {
  extractArtifactMarkers,
  isLikelyArtifactFromFileEvent,
  isSensitiveArtifactPath,
} from "../../../src/bot/services/agent-artifact-delivery-service.js";

describe("agent artifact delivery", () => {
  it("extracts explicit delivery markers without an extension whitelist", () => {
    expect(
      extractArtifactMarkers(
        "__TELEGRAM_ARTIFACT__ /tmp/site.zip\n__TELEGRAM_ARTIFACT__ /tmp/custom.binary",
      ),
    ).toEqual(["/tmp/site.zip", "/tmp/custom.binary"]);
  });

  it("recognizes binary artifacts regardless of extension", () => {
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(isLikelyArtifactFromFileEvent("/tmp/site.custom", zipHeader)).toBe(true);
  });

  it("does not require a known extension for generated text artifacts", () => {
    expect(isLikelyArtifactFromFileEvent("/tmp/generated.output", Buffer.from("hello"))).toBe(true);
  });

  it("does not auto-deliver arbitrary source edits", () => {
    expect(isLikelyArtifactFromFileEvent("/workspace/src/index.ts", Buffer.from("export const x = 1;"))).toBe(false);
  });

  it("blocks sensitive files", () => {
    expect(isSensitiveArtifactPath("/home/app/.ssh/id_ed25519")).toBe(true);
    expect(isSensitiveArtifactPath("/workspace/.env.production")).toBe(true);
    expect(isSensitiveArtifactPath("/workspace/report.pdf")).toBe(false);
  });
});


import { promises as fs } from "node:fs";
import type { Event } from "@opencode-ai/sdk/v2";
import { agentArtifactDeliveryService as delivery } from "../../../src/bot/services/agent-artifact-delivery-service.js";
import { runInTopicRuntimeContext } from "../../../src/app/services/topic-runtime-context.js";

const directory = path.resolve("/workspace/topic");
const topicA = { chatId: 100, threadId: 11, sessionId: "a", directory };
const topicB = { chatId: 100, threadId: 22, sessionId: "b", directory };
let currentTopicASessionId = "a";
const artifact = { type: "message.part.updated", properties: { part: {
  type: "tool", state: { status: "completed", input: {}, output: "__TELEGRAM_ARTIFACT__ /tmp/report.pdf" },
} } } as unknown as Event;

function enqueue(topic = topicA): void {
  if (topic.threadId === 11) currentTopicASessionId = topic.sessionId;
  runInTopicRuntimeContext(topic, () => delivery.processEvent(artifact));
}

describe("artifact destination isolation", () => {
  const send = mocked.sendDocument;
  beforeEach(() => {
    delivery.clear();
    currentTopicASessionId = "a";
    vi.useFakeTimers();
    vi.spyOn(fs, "stat").mockResolvedValue({ isFile: () => true, size: 42, mtimeMs: 1 } as never);
    mocked.resolveCoreTopicBinding.mockReset();
    mocked.resolveCoreTopicBinding.mockImplementation((chatId: number, threadId: number) => ({
      bindingId: `${chatId}:${threadId}`,
      bindingGeneration: threadId === 11 && currentTopicASessionId === "replacement" ? 2 : 1,
      chatId,
      threadId,
      sessionId: threadId === 22 ? "b" : currentTopicASessionId,
      normalizedDirectory: directory,
    }));
    mocked.isCurrentCoreSessionRoute.mockReset();
    mocked.isCurrentCoreSessionRoute.mockReturnValue(true);
    send.mockReset();
    send.mockResolvedValue({ message_id: 1 });
    delivery.setApi({} as never);
  });
  afterEach(() => { delivery.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("delivers the same path independently to two concurrent Topics", async () => {
    enqueue(topicA); enqueue(topicB);
    await vi.advanceTimersByTimeAsync(1500);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(call => call[2].message_thread_id).sort()).toEqual([11, 22]);
  });

  it("deduplicates within a session without suppressing another Topic or replacement session", async () => {
    enqueue(); await vi.advanceTimersByTimeAsync(1500);
    enqueue(); enqueue(topicB); enqueue({ ...topicA, sessionId: "replacement" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("captures the Topic destination before a later Topic is processed", async () => {
    enqueue(topicA);
    enqueue(topicB);
    await vi.advanceTimersByTimeAsync(1500);
    expect(send.mock.calls[0][0]).toBe(100);
    expect(send.mock.calls.map(call => call[2].message_thread_id).sort()).toEqual([11, 22]);
  });

  it("warns for an unroutable artifact but not for heartbeat traffic", async () => {
    const { logger } = await import("../../../src/utils/logger.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    delivery.processEvent({ type: "server.heartbeat", properties: {} } as unknown as Event);
    expect(warn).not.toHaveBeenCalled();
    delivery.processEvent(artifact);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("No Telegram destination"));
  });

  it("does not assign an initially unroutable artifact to a later chat", async () => {
    delivery.processEvent(artifact); enqueue(topicB);
    await vi.advanceTimersByTimeAsync(1500);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2].message_thread_id).toBe(22);
  });

  it("lets B send while A's upload is still pending", async () => {
    let release!: (value: unknown) => void;
    send.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    enqueue(); await vi.advanceTimersByTimeAsync(1500);
    enqueue(topicB); await vi.advanceTimersByTimeAsync(1500);
    expect(send).toHaveBeenCalledTimes(2);
    release({ message_id: 1 });
  });

  it("does not suppress B when A's upload fails", async () => {
    send.mockRejectedValueOnce(new Error("upload failed"));
    enqueue(); await vi.advanceTimersByTimeAsync(1500);
    enqueue(topicB); await vi.advanceTimersByTimeAsync(1500);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][2].message_thread_id).toBe(22);
  });

  it("cancels pending artifacts only for the retired session", async () => {
    enqueue(topicA); enqueue(topicB);
    delivery.retireSession("a");
    await vi.advanceTimersByTimeAsync(1500);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2].message_thread_id).toBe(22);
  });

  it("does not resume an old file inspection after clear", async () => {
    let release!: (value: Buffer) => void;
    vi.spyOn(fs, "readFile").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }) as never);
    runInTopicRuntimeContext(topicA, () => delivery.processEvent({
      type: "file.edited", properties: { file: "/tmp/report.pdf" },
    } as unknown as Event));
    delivery.clear();
    release(Buffer.from("%PDF-1.4"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels a file stat in flight before upload when its session retires", async () => {
    let release!: (value: unknown) => void;
    vi.mocked(fs.stat).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }) as never);
    enqueue(topicA);
    await vi.advanceTimersByTimeAsync(1500);
    delivery.retireSession("a");
    release({ isFile: () => true, size: 42, mtimeMs: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(send).not.toHaveBeenCalled();
  });
});
