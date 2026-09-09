import { describe, expect, it } from "vitest";
import {
  runInTopicRuntimeContext,
  getTopicRuntimeContext,
} from "../../../src/app/services/topic-runtime-context.js";
import { installTopicScopedSingleton } from "../../../src/app/services/topic-scoped-singleton.js";

class ClearProbe {
  private onClearedCallback: (() => void) | null = null;
  private clears = 0;

  setOnCleared(callback: () => void): void {
    this.onClearedCallback = callback;
  }

  clear(): void {
    this.clears += 1;
    this.onClearedCallback?.();
  }

  getClears(): number {
    return this.clears;
  }
}

describe("Topic-scoped singleton clear isolation", () => {
  it("does not inherit the global onCleared callback into topic instances", () => {
    const probe = installTopicScopedSingleton(new ClearProbe());
    let callbackCalls = 0;
    probe.setOnCleared(() => {
      callbackCalls += 1;
    });

    runInTopicRuntimeContext({ chatId: 100, threadId: 200, sessionId: "topic-session" }, () => {
      probe.clear();
      expect(getTopicRuntimeContext()).toEqual({
        chatId: 100,
        threadId: 200,
        sessionId: "topic-session",
      });
    });

    expect(callbackCalls).toBe(0);
    expect(probe.getClears()).toBe(0);

    probe.clear();
    expect(callbackCalls).toBe(1);
    expect(probe.getClears()).toBe(1);
  });
});
