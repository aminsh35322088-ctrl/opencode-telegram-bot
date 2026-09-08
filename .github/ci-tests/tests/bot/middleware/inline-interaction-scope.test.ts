import { beforeEach, describe, expect, it } from "vitest";
import type { Context } from "grammy";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { resolveInteractionGuardDecision } from "../../../src/bot/middleware/interaction-guard-decision.js";

function createTextContext(chatId: number, text = "hello"): Context {
  return {
    chat: { id: chatId } as Context["chat"],
    message: { text } as Context["message"],
  } as Context;
}

describe("inline interaction chat scoping", () => {
  beforeEach(() => {
    interactionManager.clear("test_setup");
  });

  it("does not let another chat inherit an inline menu state", () => {
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      metadata: { chatId: 1001, menuKind: "model", messageId: 42 },
    });

    const decision = resolveInteractionGuardDecision(createTextContext(2002));

    expect(decision.allow).toBe(true);
    expect(decision.state).toBeNull();
  });

  it("still protects the chat that owns the inline menu", () => {
    interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      metadata: { chatId: 1001, menuKind: "model", messageId: 42 },
    });

    const decision = resolveInteractionGuardDecision(createTextContext(1001));

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("expected_callback");
    expect(decision.state?.kind).toBe("inline");
  });
});
