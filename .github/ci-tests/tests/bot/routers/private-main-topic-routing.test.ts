import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMessageRouter } from "../../../src/bot/routers/message-router.js";
import { interactionManager } from "../../../src/app/managers/interaction-manager.js";
import { t } from "../../../src/i18n/index.js";
import { defined } from "../../helpers/defined.js";

const mergerMock = vi.hoisted(() => ({ queuePromptForMerging: vi.fn() }));
vi.mock("../../../src/bot/handlers/message-merger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/bot/handlers/message-merger.js")>();
  return { ...actual, queuePromptForMerging: mergerMock.queuePromptForMerging };
});

function registerAndGetTextHandler() {
  const bot = { on: vi.fn(), hears: vi.fn() };
  registerMessageRouter(bot as never, {
    ensureEventSubscription: vi.fn(),
    setTelegramContext: vi.fn(),
  });
  const call = bot.on.mock.calls.find(([event]) => event === "message:text");
  return defined(call?.[1]) as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
}

function makePrivateTopicContext(text: string, threadId?: number) {
  return {
    chat: { id: 7, type: "private" },
    me: { id: 999, is_bot: true, first_name: "OpenCode", username: "opencode_test_bot", has_topics_enabled: true },
    message: {
      text,
      ...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
    },
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

describe("private bot Main Topic routing", () => {
  beforeEach(() => {
    mergerMock.queuePromptForMerging.mockReset();
    interactionManager.clear("private_main_topic_test_reset");
  });

  it("blocks free-form AI prompts in Main when private-chat topic mode is enabled", async () => {
    const handler = registerAndGetTextHandler();
    const ctx = makePrivateTopicContext("this must not reach the model");

    await handler(ctx, vi.fn());

    expect(ctx.reply).toHaveBeenCalledWith(t("general.topic_only_prompt"));
    expect(mergerMock.queuePromptForMerging).not.toHaveBeenCalled();
  });

  it("keeps a real private conversation Topic prompt-capable", async () => {
    const handler = registerAndGetTextHandler();
    const ctx = makePrivateTopicContext("topic prompt", 731925);

    await handler(ctx, vi.fn());

    expect(ctx.reply).not.toHaveBeenCalledWith(t("general.topic_only_prompt"));
    expect(mergerMock.queuePromptForMerging).toHaveBeenCalledTimes(1);
  });
});
