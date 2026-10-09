import { beforeEach, describe, expect, it, vi } from "vitest";
const mocked = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("@opencode-telegram/native-runtime", async () => {
  const actual = await vi.importActual<typeof import("@opencode-telegram/native-runtime")>(
    "@opencode-telegram/native-runtime",
  );
  return { ...actual, renderTelegramMessageMarkdown: mocked.render };
});
describe("canonical summary renderer failure semantics", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("@opencode-telegram/native-runtime")>(
      "@opencode-telegram/native-runtime",
    );
    mocked.render.mockReset().mockImplementation(actual.renderTelegramMessageMarkdown);
  });
  it("malformed source is rendered safely instead of leaking Telegram Markdown", async () => {
    const { formatSummaryWithMode } =
      await import("../../../src/bot/messages/summary-message-formatter.js");
    expect(formatSummaryWithMode("**unfinished!", "markdown")).toEqual(["\\*\\*unfinished\\!"]);
    expect(mocked.render).toHaveBeenCalledOnce();
  });
  it("programming errors propagate instead of claiming an unsafe raw-Markdown fallback succeeded", async () => {
    const failure = new Error("conversion failed");
    mocked.render.mockImplementation(() => {
      throw failure;
    });
    const { formatSummaryWithMode } =
      await import("../../../src/bot/messages/summary-message-formatter.js");
    expect(() => formatSummaryWithMode("**raw** text!", "markdown")).toThrow(failure);
    expect(mocked.render).toHaveBeenCalledOnce();
  });
});
