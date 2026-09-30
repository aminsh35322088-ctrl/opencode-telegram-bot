import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createOpenCodeTemporarySessionRunner } from "../../../src/core/opencode-session-port.js";
import { parseTaskSchedule } from "../../../src/app/services/scheduled-task-schedule-parser-service.js";

const mocked = vi.hoisted(() => ({
  sessionGetMock: vi.fn(),
  sessionAbortMock: vi.fn(),
  sessionCreateMock: vi.fn(),
  sessionPromptMock: vi.fn(),
  sessionDeleteMock: vi.fn(),
  cleanupIgnoresMock: vi.fn(),
  registerIgnoreMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  beginCoreRunMock: vi.fn(),
  dispatchCoreOwnedTaskMock: vi.fn(),
  finishCoreRunMock: vi.fn(),
}));

vi.mock("../../../src/core/native-core-service.js", () => ({
  beginCoreRunForOwner: mocked.beginCoreRunMock,
  dispatchCoreOwnedTask: mocked.dispatchCoreOwnedTaskMock,
  finishCoreRun: mocked.finishCoreRunMock,
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      get: mocked.sessionGetMock,
      abort: mocked.sessionAbortMock,
      create: mocked.sessionCreateMock,
      prompt: mocked.sessionPromptMock,
      delete: mocked.sessionDeleteMock,
    },
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    error: mocked.loggerErrorMock,
    warn: mocked.loggerWarnMock,
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../../src/app/services/scheduled-task-session-ignore-service.js", () => ({
  cleanupScheduledTaskSessionIgnores: mocked.cleanupIgnoresMock,
  registerScheduledTaskSessionIgnore: mocked.registerIgnoreMock,
}));

const owner = {
  bindingId: "binding-1",
  botId: "bot-1",
  chatId: 100,
  threadId: 20,
  sessionId: "topic-session",
  directory: path.resolve("/workspace/schedule"),
  bindingGeneration: 1,
};

describe("app/services/scheduled-task-schedule-parser-service", () => {
  beforeEach(() => {
    mocked.sessionCreateMock.mockReset();
    mocked.sessionPromptMock.mockReset();
    mocked.sessionDeleteMock.mockReset();
    mocked.cleanupIgnoresMock.mockReset();
    mocked.registerIgnoreMock.mockReset();
    mocked.loggerErrorMock.mockReset();
    mocked.loggerWarnMock.mockReset();
    mocked.beginCoreRunMock.mockReset();
    mocked.dispatchCoreOwnedTaskMock.mockReset();
    mocked.finishCoreRunMock.mockReset();
    mocked.beginCoreRunMock.mockResolvedValue({ bindingId: owner.bindingId });
    mocked.dispatchCoreOwnedTaskMock.mockImplementation(async (_run, _label, task) =>
      task({
        signal: new AbortController().signal,
        withTemporarySession: (options: any, operation: any) => createOpenCodeTemporarySessionRunner().run(
          { sessionId: owner.sessionId, directory: owner.directory }, options, operation, new AbortController().signal,
        ),
      }),
    );
    mocked.sessionGetMock.mockReset().mockResolvedValue({ data: { id: owner.sessionId, directory: owner.directory } });
    mocked.sessionAbortMock.mockReset().mockResolvedValue({ data: true });

    mocked.sessionCreateMock.mockResolvedValue({
      data: { id: "temp-session", parentID: owner.sessionId, directory: owner.directory },
      error: null,
    });
    mocked.sessionDeleteMock.mockResolvedValue({ data: true, error: null });
    mocked.cleanupIgnoresMock.mockResolvedValue(0);
    mocked.registerIgnoreMock.mockResolvedValue(undefined);
  });

  it("parses recurring schedule JSON and removes temporary session", async () => {
    mocked.sessionPromptMock.mockResolvedValue({
      data: {
        parts: [
          {
            type: "text",
            text: JSON.stringify({
              kind: "cron",
              cron: "*/5 * * * *",
              timezone: "UTC",
              summary: "Every 5 minutes",
              nextRunAt: "2026-03-15T10:05:00.000Z",
            }),
          },
        ],
      },
      error: null,
    });

    const result = await parseTaskSchedule("every 5 minutes", path.resolve("/workspace/schedule"), owner);

    expect(result).toEqual({
      kind: "cron",
      cron: "*/5 * * * *",
      timezone: "UTC",
      summary: "Every 5 minutes",
      nextRunAt: "2026-03-15T10:05:00.000Z",
    });
    expect(mocked.beginCoreRunMock).toHaveBeenCalledWith(owner, "schedule_parse");
    expect(mocked.sessionCreateMock).toHaveBeenCalledWith({
      directory: path.resolve("/workspace/schedule"),
      title: "Scheduled task schedule parser",
      parentID: owner.sessionId,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(mocked.cleanupIgnoresMock).toHaveBeenCalledTimes(1);
    expect(mocked.registerIgnoreMock).toHaveBeenCalledWith("temp-session");
    expect(mocked.sessionDeleteMock).toHaveBeenCalledWith({ directory: path.resolve("/workspace/schedule"), sessionID: "temp-session" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(mocked.finishCoreRunMock).toHaveBeenCalledTimes(1);
  });

  it("parses one-time schedule from fenced JSON", async () => {
    mocked.sessionPromptMock.mockResolvedValue({
      data: {
        parts: [
          {
            type: "text",
            text: [
              "```json",
              JSON.stringify({
                kind: "once",
                runAt: "2026-03-16T12:00:00.000Z",
                timezone: "UTC",
                summary: "Tomorrow at 12:00",
                nextRunAt: "2026-03-16T12:00:00.000Z",
              }),
              "```",
            ].join("\n"),
          },
        ],
      },
      error: null,
    });

    const result = await parseTaskSchedule("tomorrow at 12:00", path.resolve("/workspace/schedule"), owner);

    expect(result).toEqual({
      kind: "once",
      runAt: "2026-03-16T12:00:00.000Z",
      timezone: "UTC",
      summary: "Tomorrow at 12:00",
      nextRunAt: "2026-03-16T12:00:00.000Z",
    });
    expect(mocked.sessionDeleteMock).toHaveBeenCalledWith({ directory: path.resolve("/workspace/schedule"), sessionID: "temp-session" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("cleans up temporary session when parser returns invalid JSON", async () => {
    mocked.sessionPromptMock.mockResolvedValue({
      data: {
        parts: [{ type: "text", text: "not json" }],
      },
      error: null,
    });

    await expect(parseTaskSchedule("every friday", path.resolve("/workspace/schedule"), owner)).rejects.toThrow(
      "invalid JSON",
    );
    expect(mocked.sessionDeleteMock).toHaveBeenCalledWith({ directory: path.resolve("/workspace/schedule"), sessionID: "temp-session" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
