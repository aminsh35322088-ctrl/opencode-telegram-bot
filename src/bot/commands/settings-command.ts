import type { CommandContext, Context } from "grammy";
import {
  buildSettingsMenuView,
  buildTopicModelsSettingsView,
} from "../menus/settings-menu.js";
import { replyWithInlineMenu } from "../menus/inline-menu.js";
import {
  getTopicRuntimeContext,
  runInTopicRuntimeContext,
} from "../../app/services/topic-runtime-context.js";
import { ensureTopicRuntimeStateSync } from "../../app/stores/topic-runtime-state-store.js";
import { findTelegramTopicBindingByThread } from "../../app/services/telegram-topic-store.js";

type SettingsView = ReturnType<typeof buildSettingsMenuView>;

function getThreadId(ctx: Context): number | undefined {
  const message = ctx.message ?? ctx.callbackQuery?.message;
  const threadId = message && "message_thread_id" in message
    ? (message as { message_thread_id?: number }).message_thread_id
    : undefined;
  return typeof threadId === "number" && threadId > 1 ? threadId : undefined;
}

async function buildScopedSettingsView(
  ctx: Context,
  builder: () => SettingsView,
): Promise<SettingsView> {
  const runtime = getTopicRuntimeContext();
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  const threadId = getThreadId(ctx);

  if (runtime && runtime.chatId === chatId && runtime.threadId === threadId) {
    ensureTopicRuntimeStateSync(runtime.chatId, runtime.threadId);
    return builder();
  }

  if (typeof chatId === "number" && typeof threadId === "number") {
    const binding = await findTelegramTopicBindingByThread(chatId, threadId);
    if (binding) {
      ensureTopicRuntimeStateSync(chatId, threadId, {
        session: {
          id: binding.sessionId,
          title: binding.title ?? "Telegram Topic",
          directory: binding.directory,
        },
        workspaceDirectory: binding.directory,
      });
      return runInTopicRuntimeContext(
        {
          chatId,
          threadId,
          sessionId: binding.sessionId,
          directory: binding.directory,
        },
        builder,
      );
    }
  }

  return builder();
}

export async function settingsCommand(ctx: CommandContext<Context>): Promise<void> {
  const { text, keyboard } = await buildScopedSettingsView(
    ctx as Context,
    buildSettingsMenuView,
  );

  await replyWithInlineMenu(ctx, {
    menuKind: "settings",
    text,
    keyboard,
  });
}

export async function topicModelsCommand(ctx: Context): Promise<void> {
  const { text, keyboard } = await buildScopedSettingsView(
    ctx,
    buildTopicModelsSettingsView,
  );

  await replyWithInlineMenu(ctx, {
    menuKind: "settings",
    text,
    keyboard,
  });
}
