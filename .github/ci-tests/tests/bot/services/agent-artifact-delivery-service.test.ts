import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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


import { Api } from "grammy";
import { promises as fs } from "node:fs";
import type { Event } from "@opencode-ai/sdk/v2";
import { agentArtifactDeliveryService as delivery } from "../../../src/bot/services/agent-artifact-delivery-service.js";
import { runInTopicRuntimeContext } from "../../../src/app/services/topic-runtime-context.js";

const topicA = { chatId: 100, threadId: 11, sessionId: "a" };
const topicB = { chatId: 100, threadId: 22, sessionId: "b" };
const artifact = { type: "message.part.updated", properties: { part: {
  type: "tool", state: { status: "completed", input: {}, output: "__TELEGRAM_ARTIFACT__ /tmp/report.pdf" },
} } } as unknown as Event;

function enqueue(topic = topicA): void {
  runInTopicRuntimeContext(topic, () => delivery.processEvent(artifact));
}

describe("artifact destination isolation", () => {
  let send: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    delivery.clear();
    vi.useFakeTimers();
    vi.spyOn(fs, "stat").mockResolvedValue({ isFile: () => true, size: 42, mtimeMs: 1 } as never);
    send = vi.spyOn(Api.prototype, "sendDocument").mockResolvedValue({ message_id: 1 } as never);
  });
  afterEach(() => { delivery.clear(); vi.useRealTimers(); });

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

  it("captures the main-chat destination before later focus changes", async () => {
    delivery.setChatId(100); delivery.processEvent(artifact); delivery.setChatId(200);
    await vi.advanceTimersByTimeAsync(1500);
    expect(send.mock.calls[0][0]).toBe(100);
  });

  it("does not assign an initially unroutable artifact to a later chat", async () => {
    delivery.processEvent(artifact); delivery.setChatId(200);
    await vi.advanceTimersByTimeAsync(1500);
    expect(send).not.toHaveBeenCalled();
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
});
