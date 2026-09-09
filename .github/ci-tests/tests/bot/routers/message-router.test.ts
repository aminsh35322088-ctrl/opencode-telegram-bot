import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMessageRouter } from "../../../src/bot/routers/message-router.js";
import { QUEUED_PROMPT_BUTTON_TEXT_PATTERN } from "../../../src/bot/message-patterns.js";
import { promptQueue } from "../../../src/app/managers/prompt-queue-manager.js";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { t } from "../../../src/i18n/index.js";
import { defined } from "../../helpers/defined.js";

const mergerMock = vi.hoisted(() => ({ queuePromptForMerging: vi.fn() }));
vi.mock("../../../src/bot/handlers/message-merger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/bot/handlers/message-merger.js")>();
  return { ...actual, queuePromptForMerging: mergerMock.queuePromptForMerging };
});

describe("bot/routers/message-router", () => {
  it("registers all current reply-keyboard and message routes", () => {
    const bot = {
      on: vi.fn(),
      hears: vi.fn(),
    };

    registerMessageRouter(bot as never, {
      ensureEventSubscription: vi.fn(),
      setTelegramContext: vi.fn(),
    });

    expect(bot.hears).toHaveBeenCalledTimes(9);
    expect(bot.hears.mock.calls.some(([pattern]) => pattern === QUEUED_PROMPT_BUTTON_TEXT_PATTERN)).toBe(true);
    expect(bot.hears.mock.calls).toEqual(
      expect.arrayContaining([
        [expect.any(RegExp), expect.any(Function)],
      ]),
    );
    expect(bot.on.mock.calls.map(([event]) => event)).toEqual([
      "message",
      "message:text",
      "message:text",
      "message:text",
      "message:voice",
      "message:audio",
      "message",
      "message:photo",
      "message:document",
    ]);
  });

  describe("General topic prompt gate", () => {
    function registerAndGetTextHandler() {
      const bot = { on: vi.fn(), hears: vi.fn() };
      registerMessageRouter(bot as never, {
        ensureEventSubscription: vi.fn(),
        setTelegramContext: vi.fn(),
      });
      const call = bot.on.mock.calls.find(([event]) => event === "message:text");
      return defined(call?.[1]) as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
    }

    function makeTextContext(overrides: { chat: Record<string, unknown>; message: Record<string, unknown> }) {
      return {
        chat: overrides.chat,
        message: overrides.message,
        reply: vi.fn().mockResolvedValue(undefined),
      };
    }

    beforeEach(() => {
      mergerMock.queuePromptForMerging.mockReset();
      interactionManager.clear("general_gate_test_reset");
    });

    it("blocks free-text AI prompts in the forum General topic", async () => {
      const handler = registerAndGetTextHandler();
      const ctx = makeTextContext({
        chat: { id: 42, type: "supergroup", is_forum: true },
        message: { text: "write me a python script", message_thread_id: 1 },
      });

      await handler(ctx, vi.fn());

      expect(ctx.reply).toHaveBeenCalledWith(t("general.topic_only_prompt"));
      expect(mergerMock.queuePromptForMerging).not.toHaveBeenCalled();
    });

    it("treats unthreaded forum messages as General too", async () => {
      const handler = registerAndGetTextHandler();
      const ctx = makeTextContext({
        chat: { id: 42, type: "supergroup", is_forum: true },
        message: { text: "another prompt" },
      });

      await handler(ctx, vi.fn());

      expect(ctx.reply).toHaveBeenCalledWith(t("general.topic_only_prompt"));
      expect(mergerMock.queuePromptForMerging).not.toHaveBeenCalled();
    });

    it("accepts input in General while the bot explicitly waits for text", async () => {
      interactionManager.start({ kind: "custom", expectedInput: "text", metadata: { flow: "provider" } });
      const handler = registerAndGetTextHandler();
      const ctx = makeTextContext({
        chat: { id: 42, type: "supergroup", is_forum: true },
        message: { text: "sk-abcdef123456", message_thread_id: 1 },
      });

      await handler(ctx, vi.fn());

      expect(ctx.reply).not.toHaveBeenCalledWith(t("general.topic_only_prompt"));
      expect(mergerMock.queuePromptForMerging).toHaveBeenCalled();
    });

    it("keeps AI Topics and private chats unaffected", async () => {
      const handler = registerAndGetTextHandler();
      const topicCtx = makeTextContext({
        chat: { id: 42, type: "supergroup", is_forum: true },
        message: { text: "topic prompt", message_thread_id: 42 },
      });
      await handler(topicCtx, vi.fn());
      expect(mergerMock.queuePromptForMerging).toHaveBeenCalledTimes(1);

      const privateCtx = makeTextContext({
        chat: { id: 7, type: "private" },
        message: { text: "private prompt" },
      });
      await handler(privateCtx, vi.fn());
      expect(mergerMock.queuePromptForMerging).toHaveBeenCalledTimes(2);
      expect(privateCtx.reply).not.toHaveBeenCalled();
    });
  });

  describe("queued prompt button handler", () => {
    function registerAndGetQueuedPromptHandler() {
      const bot = { on: vi.fn(), hears: vi.fn() };

      registerMessageRouter(bot as never, {
        ensureEventSubscription: vi.fn(),
        setTelegramContext: vi.fn(),
      });

      const call = bot.hears.mock.calls.find(([pattern]) => pattern === QUEUED_PROMPT_BUTTON_TEXT_PATTERN);
      return defined(call?.[1]) as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
    }

    function makeButtonContext(text: string) {
      return {
        chat: { id: 42 },
        message: { text },
        reply: vi.fn().mockResolvedValue(undefined),
      };
    }

    beforeEach(() => {
      promptQueue.__resetForTests();
      interactionManager.clear("message_router_test_reset");
    });

    it("removes the pressed prompt from the middle of the queue", async () => {
      promptQueue.add("first");
      promptQueue.add("second");
      promptQueue.add("third");
      const handler = registerAndGetQueuedPromptHandler();
      const ctx = makeButtonContext("❌ 2. second");
      const next = vi.fn();

      await handler(ctx, next);

      expect(promptQueue.list().map((item) => item.text)).toEqual(["first", "third"]);
      expect(ctx.reply).toHaveBeenCalledWith(t("queue.removed"), expect.anything());
      expect(next).not.toHaveBeenCalled();
    });

    it("never forwards a stale button label to OpenCode when the queue is empty", async () => {
      const handler = registerAndGetQueuedPromptHandler();
      const ctx = makeButtonContext("❌ 1. cleared by abort");
      const next = vi.fn();

      await handler(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(t("queue.not_found"), expect.anything());
    });

    it("answers not_found when the label no longer matches the queue", async () => {
      promptQueue.add("still queued");
      const handler = registerAndGetQueuedPromptHandler();
      const ctx = makeButtonContext("❌ 3. already gone");
      const next = vi.fn();

      await handler(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(t("queue.not_found"), expect.anything());
      expect(promptQueue.size()).toBe(1);
    });
  });
});
