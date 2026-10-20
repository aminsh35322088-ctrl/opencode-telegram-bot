import type { Context } from "grammy";
import type { FilePartInput } from "@opencode-ai/sdk/v2";
import { config } from "../../config.js";
import { isSttConfigured, transcribeAudio, type SttResult } from "../../app/services/stt-service.js";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";
import { flushPendingPrompt } from "./message-merger.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { downloadTelegramFile } from "../../app/services/file-download-service.js";
import { buildQuotedNotification } from "../../app/services/quoted-notification.js";
import { editBotText } from "../messages/telegram-text.js";
import { sanitizeAudioHistoryForTextFallback } from "../../app/services/session-error-recovery-service.js";
import { getEffectiveCurrentSession } from "../../app/services/session-service.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import { resolveCapabilityRoute } from "../../app/services/model-capability-routing-service.js";
import { findUnifiedModel } from "../../app/services/unified-model-catalog-service.js";
import { prepareNativeAudioInput } from "../../app/services/native-audio-input-service.js";
import type { ModelRef } from "../../app/types/model-capability.js";

export interface VoiceMessageDeps extends ProcessPromptDeps { isSttConfigured?: () => boolean | Promise<boolean>; downloadTelegramFile?: (ctx: Context, fileId: string) => Promise<{ buffer: Buffer; filename: string } | null>; transcribeAudio?: (audioBuffer: Buffer, filename: string, selection?: ModelRef) => Promise<SttResult>; processPrompt?: (ctx: Context, text: string, deps: ProcessPromptDeps, fileParts?: FilePartInput[]) => Promise<boolean>; }
async function downloadVoiceFile(ctx: Context, fileId: string): Promise<{ buffer: Buffer; filename: string } | null> {
  try {
    const file = await downloadTelegramFile(ctx.api, fileId, { maxBytes: 20 * 1024 * 1024 });
    let filename = file.filePath.split("/").pop() || "audio.ogg";
    if (filename.endsWith(".oga")) filename = `${filename.slice(0, -4)}.ogg`;
    logger.debug(`[Voice] Downloaded file: ${filename} (${file.buffer.length} bytes)`);
    return { buffer: file.buffer, filename };
  } catch (err) {
    logger.error("[Voice] Error downloading file from Telegram:", err);
    return null;
  }
}

export async function handleVoiceMessage(ctx: Context, deps: VoiceMessageDeps): Promise<void> {
  const sttConfigured = deps.isSttConfigured ?? isSttConfigured;
  const downloadFile = deps.downloadTelegramFile ?? downloadVoiceFile;
  const transcribe = deps.transcribeAudio ?? transcribeAudio;
  const processPrompt = deps.processPrompt ?? processUserPrompt;
  const voice = ctx.message?.voice;
  const audio = ctx.message?.audio;
  const fileId = voice?.file_id ?? audio?.file_id;
  if (!fileId) { logger.warn("[Voice] Received voice/audio message with no file_id"); return; }
  flushPendingPrompt(ctx.chat!.id);

  try {
    const topicWorktree = getTopicRuntimeContext()?.directory;
    let route = await resolveCapabilityRoute("voiceInput", topicWorktree);
    const configuredStt = await sttConfigured();
    // Preserve the recognizable Voice → Text UX when an STT endpoint is configured.
    // Native audio is a useful fallback only when transcription is not configured;
    // otherwise the user expects a transcript to appear before the Coding AI reply.
    if (route.routeSource === "primary-native" && configuredStt) {
      route = await resolveCapabilityRoute("voiceInput", topicWorktree, { allowPrimaryNative: false });
    }
    const legacyStt = route.routeSource === "unavailable" && configuredStt;
    if (route.routeSource === "unavailable" && !legacyStt) {
      await ctx.reply(route.reason ?? t("stt.not_configured"));
      return;
    }

    const fileData = await downloadFile(ctx, fileId);
    if (!fileData) { await ctx.reply(t("stt.error", { error: "download failed" })); return; }
    if (route.routeSource === "primary-native" && route.model) {
      const entry = await findUnifiedModel(route.model.providerID, route.model.modelID);
      const sourceMime = voice?.mime_type || audio?.mime_type || (fileData.filename.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/ogg");
      const prepared = await prepareNativeAudioInput(fileData.buffer, fileData.filename, sourceMime, entry?.execution);
      if (prepared) {
        const filePart: FilePartInput = {
          type: "file",
          mime: prepared.mimeType,
          filename: prepared.filename,
          url: `data:${prepared.mimeType};base64,${prepared.buffer.toString("base64")}`,
        };
        const promptText = "Listen to the attached voice message and respond to it.";
        logger.info(`[Voice] Routing verified native audio to Primary model: ${route.model.providerID}/${route.model.modelID} mime=${prepared.mimeType} transcoded=${prepared.transcoded}`);
        await processPrompt(ctx, promptText, deps, [filePart]);
        return;
      }

      logger.warn(`[Voice] Primary native-audio route was not executable for ${route.model.providerID}/${route.model.modelID}; falling back to configured STT helper.`);
      route = await resolveCapabilityRoute("voiceInput", topicWorktree, { allowPrimaryNative: false });
    }

    if (route.routeSource === "unavailable") {
      const legacySttAfterNativeFallback = await sttConfigured();
      if (!legacySttAfterNativeFallback) {
        await ctx.reply(route.reason ?? t("stt.not_configured"));
        return;
      }
    }

    const statusMessage = await ctx.reply(t("stt.recognizing"));
    const result = await transcribe(fileData.buffer, fileData.filename, route.model);
    const recognizedText = result.text.trim();
    if (!recognizedText) { await ctx.api.editMessageText(ctx.chat!.id, statusMessage.message_id, t("stt.empty_result")); return; }
    try {
      const notification = buildQuotedNotification(t(result.uncertain ? "stt.uncertain" : "stt.recognized"), recognizedText, { blankLineAfterTitle: false });
      await editBotText({ api: ctx.api, chatId: ctx.chat!.id, messageId: statusMessage.message_id, text: notification.text, rawFallbackText: notification.rawFallbackText, format: "markdown_v2" });
    } catch (editError) {
      logger.warn("[Voice] Failed to edit status message with recognized text:", editError);
      if (result.uncertain) await ctx.reply(`${t("stt.uncertain")}\n${recognizedText}`);
    }
    if (result.uncertain) return;
    logger.info(`[Voice] Transcribed audio via ${route.routeSource}: ${recognizedText.length} chars`);
    const activeSession = await getEffectiveCurrentSession();
    if (activeSession) {
      const sanitized = await sanitizeAudioHistoryForTextFallback(activeSession.id, activeSession.directory);
      if (sanitized.contaminationRemaining) {
        throw new Error("Voice transcription succeeded, but incompatible historical audio remains in the OpenCode session. The run was stopped to prevent another provider error.");
      }
      if (sanitized.removedMessageIds.length > 0) {
        logger.warn(`[Voice] Sanitized incompatible historical audio before STT text fallback: session=${activeSession.id} removed=${sanitized.removedMessageIds.length}`);
      }
    }
    let textForLLM = recognizedText;
    const notePrompt = config.stt.notePrompt.trim();
    if (notePrompt && notePrompt.toLowerCase() !== "false" && notePrompt !== "0") textForLLM = `[Note: ${notePrompt}]\n${recognizedText}`;
    await processPrompt(ctx, textForLLM, deps, []);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "unknown error";
    logger.error("[Voice] Error processing voice message:", err);
    await ctx.reply(t("stt.error", { error: errorMessage })).catch(() => {});
  }
}