import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";
import { pauseCurrentChat } from "../../../src/bot/commands/pause-command.js";

const mocked = vi.hoisted(() => ({
  status: vi.fn(),
  messages: vi.fn(),
  abort: vi.fn(),
  setPausedSession: vi.fn(),
  isChatPaused: vi.fn(),
  getKeyboard: vi.fn(),
  setPaused: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: { session: { status: mocked.status, messages: mocked.messages } },
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getEffectiveCurrentSession: vi.fn(async () => ({ id: "session-1", title: "Chat #07", directory: "/repo" })),
}));

vi.mock("../../../src/bot/commands/abort-command.js", () => ({
  abortCurrentOperation: mocked.abort,
}));

vi.mock("../../../src/app/managers/paused-session-manager.js", () => ({
  clearPausedSession: vi.fn(),
  getPausedSession: vi.fn(),
  isChatPaused: mocked.isChatPaused,
  setPausedSession: mocked.setPausedSession,
}));

vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({
  keyboardManager: {
    getKeyboard: mocked.getKeyboard,
    setPaused: mocked.setPaused,
    sendKeyboardUpdate: vi.fn(),
    markKeyboardDelivered: vi.fn(),
  },
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  getStoredModel: vi.fn(() => ({ providerID: "openai", modelID: "gpt-5" })),
}));

vi.mock("../../../src/app/types/model.js", () => ({
  formatModelForDisplay: vi.fn(() => "GPT-5"),
}));

vi.mock("../../../src/app/managers/assistant-run-state-manager.js", () => ({
  assistantRunState: { hasActiveRun: vi.fn(() => true) },
}));

vi.mock("../../../src/app/managers/foreground-session-state-manager.js", () => ({
  foregroundSessionState: { getBusySessions: vi.fn(() => []) },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("bot/commands/pause", () => {
  it("recovers the Resume keyboard when the confirmed-pause notification is rejected", async () => {
    const reply = vi.fn().mockRejectedValueOnce(new Error("Bad Request: can't parse entities")).mockResolvedValue({ message_id: 89 });
    await pauseCurrentChat({ chat: { id: 777 }, reply } as unknown as Context);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply).toHaveBeenLastCalledWith(
      "⏸️ Chat paused. Tap ▶️ Resume to continue.",
      { reply_markup: mocked.getKeyboard() },
    );
    expect(mocked.setPaused).not.toHaveBeenCalledWith(false, "session-1");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocked.status.mockResolvedValue({ data: { "session-1": { type: "busy" } }, error: null });
    mocked.messages.mockResolvedValue({ data: [], error: null });
    mocked.abort.mockResolvedValue("confirmed");
    mocked.isChatPaused.mockReturnValue(false);
    mocked.getKeyboard.mockReturnValue({ keyboard: [[{ text: "▶️ Resume" }]] });
  });

  it("delivers a confirmed pause and its Resume keyboard in one user-visible message", async () => {
    const reply = vi.fn().mockResolvedValue({ message_id: 88 });
    const editMessageText = vi.fn().mockResolvedValue(undefined);
    const ctx = { chat: { id: 777 }, reply, api: { editMessageText } } as unknown as Context;

    await pauseCurrentChat(ctx);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining("Chat paused"),
      expect.objectContaining({ reply_markup: expect.any(Object), parse_mode: "HTML" }),
    );
    expect(editMessageText).not.toHaveBeenCalled();
    expect(mocked.abort).toHaveBeenCalledWith(ctx, { notifyUser: false, restoreControls: false });
  });
});
