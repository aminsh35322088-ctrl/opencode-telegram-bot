import { describe, expect, it } from "vitest";
import {
  getTopicRuntimeContext,
  runInTopicRuntimeContext,
  withTopicSession,
} from "../../../../../src/app/services/topic-runtime-context.js";

describe("Topic runtime context isolation", () => {
  it("keeps concurrent topic/session context isolated across async work", async () => {
    const run = async (threadId: number, sessionId: string, delayMs: number) =>
      runInTopicRuntimeContext({ chatId: 100, threadId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return withTopicSession(sessionId, async () => {
          const before = getTopicRuntimeContext();
          await new Promise((resolve) => setTimeout(resolve, 5));
          const after = getTopicRuntimeContext();
          return { before, after };
        });
      });

    const [topicA, topicB] = await Promise.all([
      run(101, "session-A", 10),
      run(202, "session-B", 0),
    ]);

    expect(topicA.before).toEqual({ chatId: 100, threadId: 101, sessionId: "session-A" });
    expect(topicA.after).toEqual(topicA.before);
    expect(topicB.before).toEqual({ chatId: 100, threadId: 202, sessionId: "session-B" });
    expect(topicB.after).toEqual(topicB.before);
    expect(getTopicRuntimeContext()).toBeNull();
  });
});
