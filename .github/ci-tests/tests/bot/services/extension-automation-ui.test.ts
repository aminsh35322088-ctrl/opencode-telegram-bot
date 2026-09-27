import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  getSnapshot: vi.fn(),
  challenge: vi.fn(),
  submit: vi.fn(),
  finalize: vi.fn(),
  promptAsync: vi.fn(),
}));

vi.mock("../../../src/app/managers/interaction-manager.js", () => ({
  interactionManager: {
    getSnapshot: mocks.getSnapshot,
    clear: mocks.clear,
    start: vi.fn(),
  },
}));

vi.mock("../../../src/app/services/secure-credential-broker.js", () => ({
  getSecureCredentialChallenge: mocks.challenge,
  submitSecureCredential: mocks.submit,
  bindSecureCredentialChallenge: vi.fn(),
  cancelSecureCredentialChallenge: vi.fn(),
  findUnboundSecureCredentialChallenge: vi.fn(() => null),
}));
vi.mock("../../../src/app/services/extension-ensure-service.js", () => ({
  finalizeExtensionCredential: mocks.finalize,
  approveExtensionEnsure: vi.fn(),
  cancelExtensionEnsure: vi.fn(),
  completeExtensionOAuth: vi.fn(),
  findPendingExtensionEnsure: vi.fn(() => null),
  getExtensionEnsureRequest: vi.fn(() => null),
  getPendingExtensionOAuth: vi.fn(() => null),
}));

vi.mock("../../../src/app/services/extension-store.js", () => ({
  getStoredExtension: vi.fn(),
}));

vi.mock("../../../src/app/services/topic-runtime-context.js", () => ({
  getTopicRuntimeContext: () => ({ sessionId: "ses-secure" }),
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: () => null,
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { session: { promptAsync: mocks.promptAsync } },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
import { handleSecureExtensionMessage } from "../../../src/bot/services/extension-automation-ui.js";

function secureContext(deleteMessage: ReturnType<typeof vi.fn>): Context {
  return {
    chat: { id: 100, type: "private" },
    from: { id: 42, is_bot: false, first_name: "User" },
    message: { message_id: 900, text: "super-secret", date: 1, chat: { id: 100, type: "private" } },
    deleteMessage,
    api: { editMessageText: vi.fn().mockResolvedValue(true) },
  } as unknown as Context;
}

describe("Extension secure credential input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSnapshot.mockReturnValue({
      kind: "custom",
      expectedInput: "text",
      metadata: {
        flow: "secure-extension-credential",
        challengeId: "challenge-1",
        extensionId: "mcp:graphify",
        messageId: 700,
      },
    });
    mocks.challenge.mockReturnValue({
      id: "challenge-1",
      extensionId: "mcp:graphify",
      credentialId: "bearer",
      sessionId: "ses-secure",
      projectDirectory: "/work/repo",
      chatId: 100,
      userId: 42,
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      used: false,
    });
    mocks.finalize.mockResolvedValue({ name: "Graphify" });
    mocks.promptAsync.mockResolvedValue({ data: true, error: undefined });
  });

  it("fails closed when Telegram cannot delete the secret message", async () => {
    const ctx = secureContext(vi.fn().mockRejectedValue(new Error("delete denied")));

    await expect(handleSecureExtensionMessage(ctx)).resolves.toBe(true);

    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.promptAsync).not.toHaveBeenCalled();
    expect(mocks.clear).toHaveBeenCalledWith("secure_credential_failed");
  });

  it("stores the secret only after Telegram deletion succeeds", async () => {
    const deleteMessage = vi.fn().mockResolvedValue(true);
    mocks.submit.mockResolvedValue({
      extensionId: "mcp:graphify",
      sessionId: "ses-secure",
      projectDirectory: "/work/repo",
    });
    const ctx = secureContext(deleteMessage);

    await expect(handleSecureExtensionMessage(ctx)).resolves.toBe(true);

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledWith(
      "challenge-1",
      100,
      undefined,
      42,
      "super-secret",
    );
    expect(deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.submit.mock.invocationCallOrder[0]!,
    );
    expect(mocks.finalize).toHaveBeenCalledWith("mcp:graphify");
    expect(mocks.clear).toHaveBeenCalledWith("secure_credential_completed");
    expect(mocks.promptAsync).toHaveBeenCalled();
  });
});
