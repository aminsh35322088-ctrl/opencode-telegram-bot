import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bot, type Context } from "grammy";
import type { Update } from "grammy/types";
import { config } from "../../../src/config.js";
import { cleanupBotRuntime, createBot } from "../../../src/bot/index.js";
import * as photoHandler from "../../../src/bot/handlers/photo-handler.js";
import * as videoHandler from "../../../src/bot/handlers/video-handler.js";
import * as voiceHandler from "../../../src/bot/handlers/voice-handler.js";
import * as modelMenu from "../../../src/bot/menus/model-center-menu.js";
import * as agentMenu from "../../../src/bot/menus/agent-selection-menu.js";
import * as variantMenu from "../../../src/bot/menus/variant-selection-menu.js";
import * as contextMenu from "../../../src/bot/menus/context-control-menu.js";
import * as settingsCommand from "../../../src/bot/commands/settings-command.js";
import * as sessionsCommand from "../../../src/bot/commands/sessions-command.js";
import * as newCommand from "../../../src/bot/commands/new-command.js";
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

vi.mock("../../../src/utils/safe-background-task.js", () => ({ safeBackgroundTask: vi.fn() }));

describe("captioned forwarded media routing", () => {
  afterEach(() => {
    cleanupBotRuntime("caption_routing_test");
  });

  const captions = [
    "\u274c Cancel",
    "\u2699\ufe0f Settings",
    "\ud83d\udd58 History",
    "\ud83d\udcac New Chat",
    "\ud83d\udce6 Compact: OFF",
    "\u274c 1. queued prompt",
    "\ud83d\udee0 Build Agent",
    "\ud83d\udcca Context",
    "\ud83d\udca1 Default",
    "Please inspect this forwarded attachment",
  ];

  const media = [
    { kind: "photo", attachment: { photo: [{ file_id: "photo-id", file_unique_id: "photo-unique", width: 640, height: 480 }] } },
    { kind: "video", attachment: { video: { file_id: "video-id", file_unique_id: "video-unique", width: 640, height: 480, duration: 3 } } },
    { kind: "audio", attachment: { audio: { file_id: "audio-id", file_unique_id: "audio-unique", duration: 3 } } },
  ] as const;

  const cases = [
    ...media.flatMap((item) => captions.map((caption) => ({ ...item, caption, router: "message" as const }))),
    ...media.flatMap((item) => ["\ud83e\udde0 Model Center", "Please inspect this forwarded attachment"].map((caption) => ({ ...item, caption, router: "bot" as const }))),
  ];

  it.each(cases)("dispatches forwarded $kind with caption '$caption' through $router without opening controls", async ({ kind, attachment, caption, router }) => {
    const handlers = {
      photo: vi.spyOn(photoHandler, "handlePhotoMessage").mockResolvedValue(undefined),
      video: vi.spyOn(videoHandler, "handleVideoMessage").mockResolvedValue(undefined),
      audio: vi.spyOn(voiceHandler, "handleVoiceMessage").mockResolvedValue(undefined),
    };
    const menus = [
      vi.spyOn(modelMenu, "showModelCenterMenu").mockResolvedValue(undefined),
      vi.spyOn(agentMenu, "showAgentSelectionMenu").mockResolvedValue(undefined),
      vi.spyOn(variantMenu, "showVariantSelectionMenu").mockResolvedValue(undefined),
      vi.spyOn(contextMenu, "handleContextButtonPress").mockResolvedValue(undefined),
      vi.spyOn(settingsCommand, "settingsCommand").mockResolvedValue(undefined),
      vi.spyOn(sessionsCommand, "sessionsCommand").mockResolvedValue(undefined),
      vi.spyOn(newCommand, "newCommand").mockResolvedValue(undefined),
    ];
    const bot: Bot<Context> = router === "bot" ? createBot() : new Bot("123456:test-token");
    if (router === "message") {
      registerMessageRouter(bot, {
        ensureEventSubscription: vi.fn(),
        setTelegramContext: vi.fn(),
      });
    }
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };
    const api = vi.fn().mockResolvedValue({ ok: true, result: true });
    bot.api.config.use(api);
    const message = {
      message_id: 42,
      date: Math.floor(Date.now() / 1000),
      chat: { id: config.telegram.allowedUserId, type: "private" as const, first_name: "Owner" },
      from: { id: config.telegram.allowedUserId, is_bot: false, first_name: "Owner" },
      forward_origin: { type: "hidden_user" as const, date: 1, sender_user_name: "Original sender" },
      caption,
      ...attachment,
    };

    await bot.handleUpdate({ update_id: 42, message } as Update);

    expect(handlers[kind]).toHaveBeenCalledTimes(1);
    expect(handlers[kind]).toHaveBeenCalledWith(
      expect.objectContaining({ message }),
      expect.objectContaining({ bot, ensureEventSubscription: expect.any(Function) }),
    );
    for (const [otherKind, handler] of Object.entries(handlers)) {
      if (otherKind !== kind) expect(handler).not.toHaveBeenCalled();
    }
    for (const menu of menus) expect(menu).not.toHaveBeenCalled();
    expect(api.mock.calls.some(([, method]) => method === "sendMessage")).toBe(false);
  });
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
      "message:video",
      "message:video_note",
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
