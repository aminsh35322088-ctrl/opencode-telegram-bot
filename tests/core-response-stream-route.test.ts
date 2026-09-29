import assert from "node:assert/strict";
import { test } from "node:test";
import { ResponseStreamer } from "../src/bot/streaming/response-streamer.js";

test("interleaved response streams keep their own session route through send and edit", async () => {
  const calls: string[] = [];
  let nextId = 10;
  const streamer = new ResponseStreamer({
    throttleMs: 0,
    sendPart: async (sessionId, part) => {
      calls.push(`send:${sessionId}:${part.fallbackText}`);
      return { messageId: ++nextId, deliveredSignature: part.fallbackText };
    },
    editPart: async (sessionId, _id, part) => {
      calls.push(`edit:${sessionId}:${part.fallbackText}`);
      return { deliveredSignature: part.fallbackText };
    },
    deleteText: async () => {},
  });
  const payload = (text: string) => ({ parts: [{ blocks: [], fallbackText: text, source: "plain" as const }] });
  streamer.enqueue("session-a", "message-a", payload("one"));
  streamer.enqueue("session-b", "message-b", payload("two"));
  await Promise.all([
    streamer.complete("session-a", "message-a", payload("one updated")),
    streamer.complete("session-b", "message-b", payload("two updated")),
  ]);
  assert(calls.some((call) => call.startsWith("send:session-a:")));
  assert(calls.some((call) => call.startsWith("send:session-b:")));
  assert(calls.some((call) => call === "edit:session-a:one updated"));
  assert(calls.some((call) => call === "edit:session-b:two updated"));
});
