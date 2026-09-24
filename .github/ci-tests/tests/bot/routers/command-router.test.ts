import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, NextFunction } from "grammy";
import { defined } from "../../helpers/defined.js";

const mocked = vi.hoisted(() => ({
  flushPendingPrompt: vi.fn(),
  opencodeStopCommand: vi.fn(),
  taskCommand: vi.fn(),
  commandsCommand: vi.fn(),
  skillsCommand: vi.fn(),
}));

vi.mock("../../../src/bot/handlers/message-merger.js", () => ({
  flushPendingPrompt: mocked.flushPendingPrompt,
  __resetMessageMergerForTests: vi.fn(),
}));

vi.mock("../../../src/bot/commands/opencode-stop-command.js", () => ({
  opencodeStopCommand: mocked.opencodeStopCommand,
}));

vi.mock("../../../src/bot/commands/task-command.js", () => ({
  taskCommand: mocked.taskCommand,
}));

vi.mock("../../../src/bot/commands/command-catalog-command.js", () => ({
  commandsCommand: mocked.commandsCommand,
}));

vi.mock("../../../src/bot/commands/skills-catalog-command.js", () => ({
  skillsCommand: mocked.skillsCommand,
}));

import {
  ensureCommandsInitialized,
  registerCommandRouter,
} from "../../../src/bot/routers/command-router.js";
import { BOT_COMMANDS } from "../../../src/bot/commands/definitions.js";
import { config } from "../../../src/config.js";
import { runInTopicRuntimeContext } from "../../../src/app/services/topic-runtime-context.js";

describe("bot/routers/command-router", () => {
  beforeEach(() => {
    mocked.taskCommand.mockReset();
    mocked.commandsCommand.mockReset();
    mocked.skillsCommand.mockReset();
  });

  it.each([
    ["task", mocked.taskCommand],
    ["commands", mocked.commandsCommand],
    ["skills", mocked.skillsCommand],
  ] as const)("does not dispatch /%s to its model-backed handler in General", async (command, handler) => {
    const bot = { command: vi.fn(), use: vi.fn(), hears: vi.fn(), on: vi.fn() };
    registerCommandRouter(bot as never, { ensureEventSubscription: vi.fn(), clearRuntimeState: vi.fn() });
    const registration = bot.command.mock.calls.find(([name]) => name === command);
    const ctx = {
      chat: { id: 42, type: "supergroup", is_forum: true },
      message: { message_thread_id: 1, text: `/${command}` },
      reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as Context;

    await defined(registration?.[1])(ctx);

    expect(handler).not.toHaveBeenCalled();
  });

  it("restores a Topic keyboard on repeated explicit requests", async () => {
    const bot = { command: vi.fn(), use: vi.fn(), hears: vi.fn(), on: vi.fn() };
    registerCommandRouter(bot as never, { ensureEventSubscription: vi.fn(), clearRuntimeState: vi.fn() });
    const handler = bot.command.mock.calls.find(([command]) => command === "keyboard")![1];
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 900 });
    const ctx = { chat: { id: 123 }, api: { sendMessage }, reply: vi.fn() } as unknown as Context;
    await runInTopicRuntimeContext({ chatId: 123, threadId: 42, sessionId: "restore-session" }, async () => {
      await handler(ctx);
      await handler(ctx);
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]![2]).toMatchObject({ message_thread_id: 42, reply_markup: { resize_keyboard: true } });
    expect(sendMessage.mock.calls[1]![2].reply_markup.is_persistent).not.toBe(true);
  });

  it("keeps keyboard recovery outside an AI Topic from overwriting Topic controls", async () => {
    const bot = { command: vi.fn(), use: vi.fn(), hears: vi.fn(), on: vi.fn() };
    registerCommandRouter(bot as never, { ensureEventSubscription: vi.fn(), clearRuntimeState: vi.fn() });
    const handler = bot.command.mock.calls.find(([command]) => command === "keyboard")![1];
    const sendMessage = vi.fn();
    const reply = vi.fn();
    await handler({ chat: { id: 123 }, api: { sendMessage }, reply });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("only available inside an AI Topic"));
  });

  it("registers bot slash command handlers", () => {
    const bot = { command: vi.fn(), use: vi.fn(), hears: vi.fn(), on: vi.fn() };

    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState: vi.fn(),
    });

    expect(bot.command.mock.calls.map(([command]) => command)).toEqual([
      "start",
      "keyboard",
      "update",
      "all",
      "help",
      "status",
      "session",
      "settings",
      "topic_settings",
      "providers",
      "integrations",
      "opencode_start",
      "opencode_stop",
      "worktree",
      "open",
      "ls",
      "messages",
      "abort",
      "stop",
      "pause",
      "resume",
      "model",
      "agent",
      "variant",
      "context",
      "compact",
      "delete_topic",
      "detach",
      "task",
      "tasklist",
      "rename",
      "commands",
      "skills",
      "mcps",
      "memory",
      "remember",
      "forget",
    ]);
  });

  it("flushes a pending prompt before routing a command", async () => {
    const bot = { command: vi.fn(), use: vi.fn(), hears: vi.fn(), on: vi.fn() };
    const next = vi.fn();
    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState: vi.fn(),
    });
    const middleware = defined(bot.use.mock.calls[0]?.[0]);
    const ctx = { chat: { id: 123 }, message: { text: "/new" } } as unknown as Context;

    await middleware(ctx, next);

    expect(mocked.flushPendingPrompt).toHaveBeenCalledWith(123);
    expect(next).toHaveBeenCalledOnce();
  });

  it("passes clearRuntimeState to the opencode_stop handler", async () => {
    const bot = { command: vi.fn(), use: vi.fn(), hears: vi.fn(), on: vi.fn() };
    const clearRuntimeState = vi.fn();
    mocked.opencodeStopCommand.mockReset();
    mocked.opencodeStopCommand.mockResolvedValue(undefined);

    registerCommandRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      clearRuntimeState,
    });

    const stopRegistration = bot.command.mock.calls.find(([command]) => command === "opencode_stop");
    expect(stopRegistration).toBeDefined();

    const ctx = { chat: { id: 123 } } as unknown as Context;
    await stopRegistration?.[1](ctx);

    expect(mocked.opencodeStopCommand).toHaveBeenCalledWith(ctx, { clearRuntimeState });
  });

  it("initializes commands for the authorized chat", async () => {
    const next: NextFunction = vi.fn();
    const ctx = {
      from: { id: config.telegram.allowedUserId },
      chat: { id: 123 },
      api: { setMyCommands: vi.fn() },
    } as unknown as Context;

    await ensureCommandsInitialized(ctx, next);

    expect(ctx.api.setMyCommands).toHaveBeenCalledWith(BOT_COMMANDS, {
      scope: { type: "chat", chat_id: 123 },
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
