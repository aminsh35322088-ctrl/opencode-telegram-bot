import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const handlerSource = readFileSync(
  resolve(process.cwd(), "src/bot/callbacks/model-center-callback-handler.ts"),
  "utf8",
);

describe("Model Center session continuity", () => {
  it("keeps the active OpenCode session when the model changes", () => {
    expect(handlerSource).toContain(
      "const activeSessionId = topicSessionId ?? currentSession?.id;",
    );
    expect(handlerSource).toContain("selectModel(modelInfo);");
    expect(handlerSource).toContain("keyboardManager.updateModel(modelInfo, activeSessionId);");
  });

  it("does not use destructive session lifecycle operations during model selection", () => {
    expect(handlerSource).not.toContain("clearSession(");
    expect(handlerSource).not.toContain("rotateTelegramTopicSessionForModel");
    expect(handlerSource).not.toContain("stopEventListening(");
    expect(handlerSource).not.toContain("stopTopicEventSubscription(");
    expect(handlerSource).not.toContain("retireSessionRuntime(");
  });

  it("does not block model selection on tool-call verification state", () => {
    expect(handlerSource).not.toContain("This model button is stale");
    expect(handlerSource).not.toContain("refreshUnavailableModelAction");
    expect(handlerSource).not.toContain("Tool compatibility could not be verified");
    expect(handlerSource).toContain("Model Center was refreshed.");
  });
});
