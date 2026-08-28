import { CommandContext, Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { getTtsMode } from "../../app/stores/settings-store.js";
import { fetchCurrentAgent } from "../../app/services/agent-selection-service.js";
import { fetchCurrentModel } from "../../app/services/model-selection-service.js";
import { getAgentDisplayName } from "../../app/types/agent.js";
import { keyboardManager } from "../keyboards/keyboard-manager.js";
import { pinnedMessageManager } from "../pinned/pinned-message-manager.js";
import { logger } from "../../utils/logger.js";
import { isExpectedOpencodeUnavailableError } from "../../utils/opencode-error.js";
import { t } from "../../i18n/index.js";
import { sendBotText } from "../messages/telegram-text.js";

export async function statusCommand(ctx: CommandContext<Context>) {
  try {
    const { data, error } = await opencodeClient.global.health();

    if (error || !data) {
      throw error || new Error("No data received from server");
    }

    let message = `${t("status.header_running")}\n\n`;
    const healthLabel = data.healthy ? t("status.health.healthy") : t("status.health.unhealthy");
    message += `${t("status.line.health", { health: healthLabel })}\n`;
    if (data.version) {
      message += `${t("status.line.version", { version: data.version })}\n`;
    }
    const ttsMode = getTtsMode();
    message += `${t("status.line.tts", {
      tts:
        ttsMode === "off"
          ? t("status.tts.off")
          : ttsMode === "all"
            ? t("status.tts.all")
            : t("status.tts.auto"),
    })}\n`;

    const currentAgent = await fetchCurrentAgent();
    const agentDisplay = currentAgent
      ? getAgentDisplayName(currentAgent)
      : t("status.agent_not_set");
    message += `${t("status.line.mode", { mode: agentDisplay })}\n`;

    const currentModel = fetchCurrentModel();
    const modelDisplay = `🧠 ${currentModel.providerID}/${currentModel.modelID}`;
    message += `${t("status.line.model", { model: modelDisplay })}\n`;

    const currentSession = getCurrentSession();
    if (currentSession) {
      message += `\n${t("status.session_selected", { title: currentSession.title })}\n`;
    } else {
      message += `\n${t("status.session_not_selected")}\n`;
      message += t("status.session_hint");
    }

    if (ctx.chat) {
      if (!pinnedMessageManager.isInitialized()) {
        pinnedMessageManager.initialize(ctx.api, ctx.chat.id);
      }
      if (pinnedMessageManager.getContextLimit() === 0) {
        await pinnedMessageManager.refreshContextLimit();
      }
      keyboardManager.initialize(ctx.api, ctx.chat.id);
    }

    const contextInfo = pinnedMessageManager.getContextInfo();
    if (contextInfo) {
      keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);
    }
    const keyboard = keyboardManager.getKeyboard();
    if (ctx.chat) {
      await sendBotText({
        api: ctx.api,
        chatId: ctx.chat.id,
        text: message,
        options: keyboard ? { reply_markup: keyboard } : {},
      });
    } else {
      await ctx.reply(message, keyboard ? { reply_markup: keyboard } : {});
    }
  } catch (error) {
    if (isExpectedOpencodeUnavailableError(error)) {
      logger.warn("[Bot] OpenCode server unavailable; cannot report status");
    } else {
      logger.error("[Bot] Error checking server status:", error);
    }
    await ctx.reply(t("status.server_unavailable"));
  }
}
