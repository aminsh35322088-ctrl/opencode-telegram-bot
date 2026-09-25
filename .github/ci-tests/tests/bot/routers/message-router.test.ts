import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMessageRouter } from "../../../src/bot/routers/message-router.js";
import { QUEUED_PROMPT_BUTTON_TEXT_PATTERN } from "../../../src/bot/message-patterns.js";
import { promptQueue } from "../../../src/app/managers/prompt-queue-manager.js";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { t } from "../../../src/i18n/index.js";
import { defined } from "../../helpers/defined.js";

const mergerMock = vi.hoisted(() => ({ queuePromptForMerging: vi.fn() }));
const mediaMocks = vi.hoisted(() => ({
  handleVoiceMessage: vi.fn(),
  handlePhotoMessage: vi.fn(),
  handleVideoMessage: vi.fn(),
  handleDocumentMessage: vi.fn(),
}));

vi.mock("../../../src/bot/handlers/message-merger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/bot/handlers/message-merger.js")>();
  return { ...actual, queuePromptForMerging: mergerMock.queuePromptForMerging };
});
vi.mock("../../../src/bot/handlers/voice-handler.js", () => ({
  handleVoiceMessage: mediaMocks.handleVoiceMessage,
}));
vi.mock("../../../src/bot/handlers/photo-handler.js", () => ({
  handlePhotoMessage: mediaMocks.handlePhotoMessage,
}));
vi.mock("../../../src/bot/handlers/video-handler.js", () => ({
  handleVideoMessage: mediaMocks.handleVideoMessage,
}));
vi.mock("../../../src/bot/handlers/document-handler.js", () => ({
  handleDocumentMessage: mediaMocks.handleDocumentMessage,
}));

function getMessageHandler(eventName: string): (ctx: unknown, next: () => Promise<void>) => Promise<void> {
  const bot = { on: vi.fn(), hears: vi.fn() };
  registerMessageRouter(bot as never, {
    ensureEventSubscription: vi.fn(),
    setTelegramContext: vi.fn(),
  });
  const call = bot.on.mock.calls.find(([event]) => event === eventName);
  return defined(call?.[1]) as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
}

function makeMediaContext({
  chatId,
  threadId,
  media,
}: {
  chatId: number;
  threadId: number;
  media: Record<string, unknown>;
}) {
  return {
    api: {},
    chat: { id: chatId, type: "supergroup", is_forum: true },
    message: {
      message_id: 100,
      date: Math.floor(Date.now() / 1000),
      message_thread_id: threadId,
      ...media,
    },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

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
      mediaMocks.handleVoiceMessage.mockReset();
      mediaMocks.handlePhotoMessage.mockReset();
      mediaMocks.handleVideoMessage.mockReset();
      mediaMocks.handleDocumentMessage.mockReset();
      interactionManager.clear("general_gate_test_reset");
    });

    it.each([
      {
        eventName: "message:voice",
        handler: mediaMocks.handleVoiceMessage,
        media: {
          voice: {
            file_id: "voice-file",
            file_unique_id: "voice-unique",
            duration: 2,
            mime_type: "audio/ogg",
            file_size: 128,
          },
        },
      },
      {
        eventName: "message:audio",
        handler: mediaMocks.handleVoiceMessage,
        media: {
          audio: {
            file_id: "audio-file",
            file_unique_id: "audio-unique",
            duration: 12,
            mime_type: "audio/mpeg",
            file_size: 256,
          },
        },
      },
      {
        eventName: "message:photo",
        handler: mediaMocks.handlePhotoMessage,
        media: {
          caption: "photo prompt",
          photo: [
            { file_id: "photo-small", file_unique_id: "photo-small", width: 90, height: 90, file_size: 1000 },
            { file_id: "photo-large", file_unique_id: "photo-large", width: 1280, height: 960, file_size: 5000 },
          ],
        },
      },
      {
        eventName: "message:video",
        handler: mediaMocks.handleVideoMessage,
        media: {
          caption: "video prompt",
          video: {
            file_id: "video-file",
            file_unique_id: "video-unique",
            file_name: "clip.mp4",
            mime_type: "video/mp4",
            file_size: 2048,
            width: 1280,
            height: 720,
            duration: 12,
          },
        },
      },
      {
        eventName: "message:video_note",
        handler: mediaMocks.handleVideoMessage,
        media: {
          caption: "video note prompt",
          video_note: {
            file_id: "video-note-file",
            file_unique_id: "video-note-unique",
            file_size: 1024,
            length: 10,
            duration: 10,
          },
        },
      },
      {
        eventName: "message:document",
        handler: mediaMocks.handleDocumentMessage,
        media: {
          caption: "document prompt",
          document: {
            file_id: "document-file",
            file_unique_id: "document-unique",
            file_name: "notes.txt",
            mime_type: "text/plain",
            file_size: 512,
          },
        },
      },
    ])("does not dispatch $eventName to the model in General", async ({ eventName, handler, media }) => {
      const route = getMessageHandler(eventName);
      const ctx = makeMediaContext({ chatId: 42, threadId: 1, media });
      const next = vi.fn().mockResolvedValue(undefined);

      await route(ctx, next);

      expect(handler).not.toHaveBeenCalled();
      expect(mergerMock.queuePromptForMerging).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(t("general.topic_only_prompt"));
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
