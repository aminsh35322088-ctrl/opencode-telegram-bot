import type { Bot } from "grammy";
import { CommandContext, Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { setCurrentSession, getCurrentSessionDirectory } from "../../app/services/session-service.js";
import type { SessionInfo } from "../../app/types/session.js";
import { ingestSessionInfoForCache } from "../../app/services/session-cache-service.js";
import { clearAllInteractionState } from "../../app/managers/interaction-manager.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { getStoredAgent, resolveProjectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { attachToSession } from "../../app/services/attach-service.js";
import { clearPausedSession } from "../../app/managers/paused-session-manager.js";

export interface NewCommandDeps {
  bot: Bot<Context>;
  ensureEventSubscription: (directory: string) => Promise<void>;
}

export async function newCommand(ctx: CommandContext<Context>, deps: NewCommandDeps) {
  try {
    clearPausedSession();
    keyboardManager.setPaused(false);

    if (isForegroundBusy()) {
      await replyBusyBlocked(ctx);
      return;
    }

    const directory = getCurrentSessionDirectory();
    logger.debug("[Bot] Creating new session for directory:", directory);

    const { data: session, error } = await opencodeClient.session.create({ directory });

    if (error || !session) {
      throw error || new Error("No data received from server");
    }

    logger.info(
      `[Bot] Created new session via /new command: id=${session.id}, title="${session.title}", directory=${directory}`,
    );

    const sessionInfo: SessionInfo = {
      id: session.id,
      title: session.title,
      directory,
    };
    setCurrentSession(sessionInfo);
    clearAllInteractionState("session_created");
    await ingestSessionInfoForCache(session);

    await attachToSession({
      bot: deps.bot,
      chatId: ctx.chat.id,
      session: sessionInfo,
      ensureEventSubscription: deps.ensureEventSubscription,
    });

    const currentAgent = await resolveProjectAgent(getStoredAgent());
    const currentModel = getStoredModel();
    keyboardManager.updateAgent(currentAgent);
    const contextInfo = keyboardManager.getContextInfo();
    const variantName = formatVariantForButton(currentModel.variant || "default");
    const keyboard = createMainKeyboard(currentAgent, currentModel, contextInfo ?? undefined, variantName);

    await ctx.reply(t("new.created", { title: session.title }), {
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error("[Bot] Error creating session:", error);
    await ctx.reply(t("new.create_error"));
  }
}
