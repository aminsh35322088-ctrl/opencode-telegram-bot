import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abort: vi.fn(),
  status: vi.fn(),
  messages: vi.fn(),
  deleteMessage: vi.fn(),
  markAbortExpected: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      abort: mocks.abort,
      status: mocks.status,
      messages: mocks.messages,
      deleteMessage: mocks.deleteMessage,
    },
  },
}));

vi.mock("../../../src/app/managers/abort-suppression-manager.js", () => ({
  markAbortExpected: mocks.markAbortExpected,
}));

import {
  extractUnsupportedFilePartMime,
  recoverSessionAfterError,
  sanitizeAudioHistoryForTextFallback,
} from "../../../src/app/services/session-error-recovery-service.js";

describe("session error recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.abort.mockResolvedValue({ data: true, error: null });
    mocks.status.mockResolvedValue({ data: {}, error: null });
    mocks.deleteMessage.mockResolvedValue({ data: true, error: null });
  });

  it("parses OpenCode unsupported FilePart media errors", () => {
    expect(extractUnsupportedFilePartMime("'file part media type audio/ogg' functionality not supported.")).toBe("audio/ogg");
    expect(extractUnsupportedFilePartMime("provider exploded")).toBeNull();
  });

  it("auto-aborts and surgically deletes only messages containing the rejected MIME", async () => {
    mocks.messages
      .mockResolvedValueOnce({
        data: [
          { info: { id: "bad-audio", role: "user" }, parts: [{ id: "p1", type: "file", mime: "audio/ogg" }] },
          { info: { id: "keep-text", role: "user" }, parts: [{ id: "p2", type: "text", text: "hello" }] },
          { info: { id: "keep-image", role: "user" }, parts: [{ id: "p3", type: "file", mime: "image/png" }] },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          { info: { id: "keep-text", role: "user" }, parts: [{ id: "p2", type: "text", text: "hello" }] },
          { info: { id: "keep-image", role: "user" }, parts: [{ id: "p3", type: "file", mime: "image/png" }] },
        ],
        error: null,
      });

    const result = await recoverSessionAfterError(
      "session-1",
      "/repo",
      "'file part media type audio/ogg' functionality not supported.",
    );

    expect(mocks.markAbortExpected).toHaveBeenCalledWith("session-1");
    expect(mocks.abort).toHaveBeenCalledWith(
      { sessionID: "session-1", directory: "/repo" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.deleteMessage).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMessage).toHaveBeenCalledWith({ sessionID: "session-1", messageID: "bad-audio", directory: "/repo" });
    expect(result).toMatchObject({
      abortAttempted: true,
      abortAccepted: true,
      unsupportedMime: "audio/ogg",
      removedMessageIds: ["bad-audio"],
      contaminationRemaining: false,
    });
  });

  it("preflights text STT fallback by removing historical audio messages before the next prompt", async () => {
    mocks.messages
      .mockResolvedValueOnce({
        data: [
          { info: { id: "old-native-audio" }, parts: [{ id: "p1", type: "file", mime: "audio/ogg" }] },
          { info: { id: "keep" }, parts: [{ id: "p2", type: "file", mime: "image/png" }] },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ info: { id: "keep" }, parts: [{ id: "p2", type: "file", mime: "image/png" }] }],
        error: null,
      });

    const result = await sanitizeAudioHistoryForTextFallback("session-1", "/repo");
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.deleteMessage).toHaveBeenCalledWith({ sessionID: "session-1", messageID: "old-native-audio", directory: "/repo" });
    expect(result).toEqual({ removedMessageIds: ["old-native-audio"], contaminationRemaining: false });
  });
});
