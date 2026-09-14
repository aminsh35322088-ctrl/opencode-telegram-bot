import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, Context } from "grammy";
import { sessionCommand } from "../../../src/bot/commands/session-command.js";

const mocked = vi.hoisted(() => ({
  currentSession: {
    id: "session-1",
    title: "Implement OpenCode capabilities",
    directory: "/workspace/repo",
  } as { id: string; title: string; directory: string } | null,
  statusMock: vi.fn(),
  todoMock: vi.fn(),
  diffMock: vi.fn(),
  childrenMock: vi.fn(),
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: vi.fn(() => mocked.currentSession),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      status: mocked.statusMock,
      todo: mocked.todoMock,
      diff: mocked.diffMock,
      children: mocked.childrenMock,
    },
  },
}));

function createContext(): CommandContext<Context> {
  return {
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown as CommandContext<Context>;
}

describe("bot/commands/session", () => {
  beforeEach(() => {
    mocked.currentSession = {
      id: "session-1",
      title: "Implement OpenCode capabilities",
      directory: "/workspace/repo",
    };
    mocked.statusMock.mockReset();
    mocked.todoMock.mockReset();
    mocked.diffMock.mockReset();
    mocked.childrenMock.mockReset();

    mocked.statusMock.mockResolvedValue({
      data: { "session-1": { type: "busy" } },
      error: null,
    });
    mocked.todoMock.mockResolvedValue({
      data: [
        { content: "Wire session dashboard", status: "in_progress", priority: "high" },
        { content: "Run CI", status: "pending", priority: "medium" },
        { content: "Audit existing APIs", status: "completed", priority: "low" },
      ],
      error: null,
    });
    mocked.diffMock.mockResolvedValue({
      data: [
        { file: "src/bot/commands/session-command.ts", additions: 120, deletions: 0 },
        { file: "src/bot/routers/command-router.ts", additions: 2, deletions: 0 },
      ],
      error: null,
    });
    mocked.childrenMock.mockResolvedValue({
      data: [{ id: "child-1", title: "Research child" }],
      error: null,
    });
  });

  it("renders native OpenCode session status, todos, diff and children", async () => {
    const ctx = createContext();

    await sessionCommand(ctx);

    expect(mocked.statusMock).toHaveBeenCalledWith({ directory: "/workspace/repo" });
    expect(mocked.todoMock).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/workspace/repo",
    });
    expect(mocked.diffMock).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/workspace/repo",
    });
    expect(mocked.childrenMock).toHaveBeenCalledWith({
      sessionID: "session-1",
      directory: "/workspace/repo",
    });

    const replyMock = ctx.reply as unknown as ReturnType<typeof vi.fn>;
    const text = replyMock.mock.calls[0]?.[0] as string;
    expect(text).toContain("🧭 OpenCode Session");
    expect(text).toContain("Implement OpenCode capabilities");
    expect(text).toContain("State: 🟡 busy");
    expect(text).toContain("3 total · 2 active · 1 done");
    expect(text).toContain("🔄 [high] Wire session dashboard");
    expect(text).toContain("2 files · +122 / -0");
    expect(text).toContain("src/bot/commands/session-command.ts");
    expect(text).toContain("🌿 Child sessions: 1");
    expect(text).toContain("Research child");
  });

  it("renders partial dashboard when one OpenCode capability fails", async () => {
    mocked.todoMock.mockResolvedValue({
      data: undefined,
      error: new Error("todo unavailable"),
    });
    const ctx = createContext();

    await sessionCommand(ctx);

    const replyMock = ctx.reply as unknown as ReturnType<typeof vi.fn>;
    const text = replyMock.mock.calls[0]?.[0] as string;
    expect(text).toContain("📝 OpenCode todos: unavailable");
    expect(text).toContain("🧩 Session changes: 2 files");
    expect(text).toContain("🌿 Child sessions: 1");
  });

  it("does not call OpenCode APIs without an active session", async () => {
    mocked.currentSession = null;
    const ctx = createContext();

    await sessionCommand(ctx);

    expect(ctx.reply).toHaveBeenCalledWith(
      "ℹ️ No active OpenCode session. Open or attach to a session first.",
    );
    expect(mocked.statusMock).not.toHaveBeenCalled();
    expect(mocked.todoMock).not.toHaveBeenCalled();
    expect(mocked.diffMock).not.toHaveBeenCalled();
    expect(mocked.childrenMock).not.toHaveBeenCalled();
  });
});
