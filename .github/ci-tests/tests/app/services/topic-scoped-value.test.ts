import { describe, expect, it } from "vitest";
import { TopicScopedValue } from "../../../src/app/services/topic-scoped-value.js";
import { runInTopicRuntimeContext } from "../../../src/app/services/topic-runtime-context.js";

interface WizardState {
  step: string;
  messageId: number;
}

describe("app/services/topic-scoped-value", () => {
  it("keeps concurrent Topics in independent scopes", () => {
    const wizard = new TopicScopedValue<WizardState>();

    runInTopicRuntimeContext({ chatId: 100, threadId: 11, sessionId: "s-a" }, () => {
      wizard.set({ step: "name", messageId: 1 });
    });
    runInTopicRuntimeContext({ chatId: 100, threadId: 12, sessionId: "s-b" }, () => {
      wizard.set({ step: "url", messageId: 2 });
    });

    const scopeA = runInTopicRuntimeContext({ chatId: 100, threadId: 11, sessionId: "s-a" }, () => wizard.get());
    const scopeB = runInTopicRuntimeContext({ chatId: 100, threadId: 12, sessionId: "s-b" }, () => wizard.get());
    expect(scopeA?.step).toBe("name");
    expect(scopeB?.step).toBe("url");

    runInTopicRuntimeContext({ chatId: 100, threadId: 11, sessionId: "s-a" }, () => wizard.clear());
    const clearedA = runInTopicRuntimeContext({ chatId: 100, threadId: 11, sessionId: "s-a" }, () => wizard.isActive());
    const stillActiveB = runInTopicRuntimeContext({ chatId: 100, threadId: 12, sessionId: "s-b" }, () => wizard.isActive());
    expect(clearedA).toBe(false);
    expect(stillActiveB).toBe(true);
  });

  it("separates the main chat scope from Topic scopes", () => {
    const wizard = new TopicScopedValue<WizardState>();
    wizard.set({ step: "main", messageId: 7 });
    expect(wizard.isActive()).toBe(true);

    const topicActive = runInTopicRuntimeContext({ chatId: 100, threadId: 11, sessionId: "s-a" }, () => wizard.isActive());
    expect(topicActive).toBe(false);

    runInTopicRuntimeContext({ chatId: 100, threadId: 11, sessionId: "s-a" }, () => wizard.clear());
    expect(wizard.get()?.step).toBe("main");
  });

  it("applies in-place mutations to the stored reference", () => {
    const wizard = new TopicScopedValue<WizardState>();
    runInTopicRuntimeContext({ chatId: 100, threadId: 11, sessionId: "s-a" }, () => {
      wizard.set({ step: "name", messageId: 1 });
      const value = wizard.get();
      if (value) value.step = "token";
    });
    const step = runInTopicRuntimeContext({ chatId: 100, threadId: 11, sessionId: "s-a" }, () => wizard.get()?.step);
    expect(step).toBe("token");
  });
});
