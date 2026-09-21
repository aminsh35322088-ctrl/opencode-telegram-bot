[Reading 83 lines from start (total: 83 lines, 0 remaining)]

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { rustDeskSecureInputManager } from "../../../src/app/managers/rustdesk-secure-input-manager.js";
import { handleRustDeskSecureInputMessage } from "../../../src/bot/handlers/rustdesk-secure-input-handler.js";
import { t } from "../../../src/i18n/index.js";

const mocks = vi.hoisted(() => ({
  submitCredential: vi.fn(),
}));

vi.mock("../../../src/app/services/rustdesk-bridge-service.js", () => ({
  createRustDeskBridgeClientFromEnv: () => ({
    submitCredential: mocks.submitCredential,
  }),
}));

vi.mock("../../../src/app/services/topic-runtime-context.js", () => ({
  getTopicRuntimeContext: () => ({ sessionId: "session-1" }),
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: () => null,
}));

function makeContext(text: string) {
  return {
    chat: { id: 42 },
    message: { text, message_id: 77 },
    api: { deleteMessage: vi.fn().mockResolvedValue(undefined) },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("RustDesk secure input handler", () => {
  beforeEach(() => {
    mocks.submitCredential.mockReset().mockResolvedValue({ ok: true });
    rustDeskSecureInputManager.__resetForTests();
    rustDeskSecureInputManager.start({
      sessionId: "session-1",
      callId: "call-1",
      chatId: 42,
      credentialRequestId: "cred-1",
      connectionId: "conn-1",
      credentialKind: "rustdesk-password",
    });
    rustDeskSecureInputManager.setPromptMessageId("session-1", "cred-1", 55);
  });

  it("deletes and submits secure input without forwarding it to the model", async () => {
    const ctx = makeContext("fixture-value");

    await expect(handleRustDeskSecureInputMessage(ctx)).resolves.toBe(true);

    expect(ctx.api.deleteMessage).toHaveBeenNthCalledWith(1, 42, 77);
    expect(mocks.submitCredential).toHaveBeenCalledWith({
      credentialRequestId: "cred-1",
      credential: "fixture-value",
      trustThisDevice: false,
    });
    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(42, 55);
    expect(ctx.reply).toHaveBeenCalledWith(t("rustdesk.secure_input.submitted"));
    expect(rustDeskSecureInputManager.isActive("session-1")).toBe(false);
  });

  it("keeps the challenge active when bridge submission fails", async () => {
    mocks.submitCredential.mockRejectedValueOnce(new Error("bridge unavailable"));
    const ctx = makeContext("fixture-value");

    await expect(handleRustDeskSecureInputMessage(ctx)).resolves.toBe(true);

    expect(ctx.reply).toHaveBeenCalledWith(t("rustdesk.secure_input.failed"));
    expect(rustDeskSecureInputManager.isActive("session-1")).toBe(true);
  });

  it("lets control commands pass through instead of treating them as credentials", async () => {
    const ctx = makeContext("/abort");

    await expect(handleRustDeskSecureInputMessage(ctx)).resolves.toBe(false);

    expect(mocks.submitCredential).not.toHaveBeenCalled();
    expect(ctx.api.deleteMessage).not.toHaveBeenCalled();
  });
});

[executed on device: runnervmlun5p (3784ff4d-04bd-49e4-95bf-176085794429)]