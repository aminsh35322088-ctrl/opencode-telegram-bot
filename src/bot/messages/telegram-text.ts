import type { Api, RawApi } from "grammy";
import type { InputRichMessageWithoutUpload, MessageEntity } from "grammy/types";
import { logger } from "../../utils/logger.js";
import {
  editMessageWithMarkdownFallback,
  isTelegramBadRequestError,
  sendMessageWithMarkdownFallback,
} from "./send-with-markdown-fallback.js";
import { chunkPlainText } from "../render/chunker.js";
import { TELEGRAM_TEXT_MESSAGE_LIMIT } from "../render/limits.js";
import { buildSourcePreservingRichHtml } from "../render/rich-html-fallback.js";
import { getTelegramRenderedPartSignature } from "../render/part-signature.js";
import { shouldRenderRtl } from "../render/text-direction.js";
import type { TelegramRenderedPart } from "../render/types.js";

type SendMessageApi = Pick<Api<RawApi>, "sendMessage" | "sendRichMessage">;
type EditMessageApi = Pick<Api<RawApi>, "editMessageText">;
type SendDraftApi = Pick<Api<RawApi>, "sendMessageDraft" | "sendRichMessageDraft">;
type CompleteDraftApi = Pick<
  Api<RawApi>,
  "sendMessage" | "sendRichMessage" | "deleteMessage"
>;

type TelegramSendMessageOptions = Parameters<SendMessageApi["sendMessage"]>[2];
type TelegramEditMessageOptions = Parameters<EditMessageApi["editMessageText"]>[3];
type TelegramSendRichOptions = Parameters<SendMessageApi["sendRichMessage"]>[2];

export type TelegramTextFormat = "raw" | "markdown_v2";

interface SendBotTextParams {
  api: Pick<Api<RawApi>, "sendMessage">;
  chatId: Parameters<SendMessageApi["sendMessage"]>[0];
  text: string;
  rawFallbackText?: string | undefined;
  options?: TelegramSendMessageOptions | undefined;
  format?: TelegramTextFormat | undefined;
}

interface EditBotTextParams {
  api: EditMessageApi;
  chatId: Parameters<EditMessageApi["editMessageText"]>[0];
  messageId: Parameters<EditMessageApi["editMessageText"]>[1];
  text: string;
  rawFallbackText?: string | undefined;
  options?: TelegramEditMessageOptions | undefined;
  format?: TelegramTextFormat | undefined;
}

interface SendRenderedBotPartParams {
  api: SendMessageApi & Partial<SendDraftApi>;
  /** Native draft methods only accept private-chat numeric IDs. */
  chatId: number;
  part: TelegramRenderedPart;
  options?: TelegramSendMessageOptions;
  /** Streaming callers degrade whole payloads themselves and must opt out. */
  allowPlainFallback?: boolean;
}

interface EditRenderedBotPartParams {
  api: EditMessageApi & Partial<SendMessageApi & SendDraftApi>;
  /** Native draft methods only accept private-chat numeric IDs. */
  chatId: number;
  messageId: Parameters<EditMessageApi["editMessageText"]>[1];
  part: TelegramRenderedPart;
  options?: TelegramEditMessageOptions;
  allowPlainFallback?: boolean;
}

interface RenderedPartDeliveryResult {
  deliveredSignature: string;
  degradedToPlain?: boolean;
}

interface RenderedPartSendResult extends RenderedPartDeliveryResult {
  messageId: number;
}

interface RenderedPartCompleteResult extends RenderedPartSendResult {
  rollback: () => Promise<void>;
}

export { getTelegramRenderedPartSignature };

const IMPLICIT_THINKING_DRAFT_MIN = 1_500_000_000;
const IMPLICIT_THINKING_DRAFT_MAX = 2_000_000_000;
const THINKING_DRAFT_TTL_MS = 5 * 60 * 1000;
let nextImplicitThinkingDraftId = IMPLICIT_THINKING_DRAFT_MIN;
const activeThinkingDrafts = new Map<string, number>();

function resolveParseMode(format: TelegramTextFormat | undefined): "MarkdownV2" | undefined {
  if (format === "markdown_v2") {
    return "MarkdownV2";
  }

  return undefined;
}

function stripRichFormattingOptions<T extends TelegramSendMessageOptions | undefined>(
  options: T,
): T {
  if (!options) {
    return options;
  }

  const rawOptions = {
    ...options,
  } as NonNullable<T> & { parse_mode?: unknown };

  delete rawOptions.parse_mode;

  return rawOptions as T;
}

function isPlainPart(part: TelegramRenderedPart): boolean {
  return part.source === "plain" || part.blocks.length === 0;
}

function isThinkingPart(part: TelegramRenderedPart): boolean {
  return part.blocks.some((block) => block.type === "thinking");
}

/**
 * Code blocks stay LTR no matter what language their string literals quote:
 * a part made solely of `pre` blocks must never take an RTL base, mirroring
 * the "code is never flipped" invariant of RTL typography helpers.
 */
function isCodeOnlyPart(part: TelegramRenderedPart): boolean {
  return part.blocks.length > 0 && part.blocks.every((block) => block.type === "pre");
}

function toInputRichMessage(part: TelegramRenderedPart): InputRichMessageWithoutUpload {
  if (isCodeOnlyPart(part)) {
    return { blocks: part.blocks };
  }

  return {
    blocks: part.blocks,
    ...(shouldRenderRtl(part.fallbackText) ? { is_rtl: true } : {}),
  };
}

function plainSignature(text: string, entities?: MessageEntity[]): string {
  return getTelegramRenderedPartSignature({
    blocks: [],
    fallbackText: text,
    source: "plain",
    entities,
  });
}

/** Plain parts may carry entities; today only reasoning does. */
function withPlainEntities<T extends { entities?: MessageEntity[] } | undefined>(
  options: T,
  part: TelegramRenderedPart,
): T {
  if (!part.entities?.length) {
    return options;
  }

  return { ...(options ?? {}), entities: part.entities } as T;
}

function hasRichDraftApi(api: Partial<SendDraftApi>): api is SendDraftApi {
  return (
    typeof api.sendMessageDraft === "function" &&
    typeof api.sendRichMessageDraft === "function"
  );
}

function hasSendMessageApi(api: Partial<SendMessageApi>): api is SendMessageApi {
  return typeof api.sendMessage === "function" && typeof api.sendRichMessage === "function";
}

function thinkingDraftKey(chatId: number, draftId: number): string {
  return `${chatId}:${draftId}`;
}

function cleanupExpiredThinkingDrafts(now = Date.now()): void {
  for (const [key, expiresAt] of activeThinkingDrafts) {
    if (expiresAt <= now) activeThinkingDrafts.delete(key);
  }
}

function allocateThinkingDraftId(): number {
  const draftId = nextImplicitThinkingDraftId;
  nextImplicitThinkingDraftId += 1;
  if (nextImplicitThinkingDraftId >= IMPLICIT_THINKING_DRAFT_MAX) {
    nextImplicitThinkingDraftId = IMPLICIT_THINKING_DRAFT_MIN;
  }
  return draftId;
}

function markThinkingDraft(chatId: number, draftId: number): void {
  cleanupExpiredThinkingDrafts();
  activeThinkingDrafts.set(thinkingDraftKey(chatId, draftId), Date.now() + THINKING_DRAFT_TTL_MS);
}

function consumeThinkingDraft(chatId: number, draftId: number): boolean {
  cleanupExpiredThinkingDrafts();
  return activeThinkingDrafts.delete(thinkingDraftKey(chatId, draftId));
}

function isActiveThinkingDraft(chatId: number, draftId: number): boolean {
  cleanupExpiredThinkingDrafts();
  return activeThinkingDrafts.has(thinkingDraftKey(chatId, draftId));
}

const GENERATION_DRAFT_OPTIONS = {
  can_stop: true,
  keep_on_stop: true,
} as const;

export async function sendBotText({
  api,
  chatId,
  text,
  rawFallbackText,
  options,
  format = "raw",
}: SendBotTextParams): Promise<void> {
  await sendMessageWithMarkdownFallback({
    api,
    chatId,
    text,
    rawFallbackText,
    options,
    parseMode: resolveParseMode(format),
  });
}

export async function sendRenderedBotPart({
  api,
  chatId,
  part,
  options,
  allowPlainFallback = true,
}: SendRenderedBotPartParams): Promise<RenderedPartSendResult> {
  const rawOptions = stripRichFormattingOptions(options);

  logger.debug("[Bot] Sending rendered Telegram part", {
    source: part.source,
    blockCount: part.blocks.length,
    fallbackTextLength: part.fallbackText.length,
  });

  if (isThinkingPart(part) && hasRichDraftApi(api)) {
    const draftId = allocateThinkingDraftId();
    try {
      await api.sendRichMessageDraft(
        chatId,
        draftId,
        toInputRichMessage(part),
        GENERATION_DRAFT_OPTIONS,
      );
      markThinkingDraft(chatId, draftId);
      return {
        messageId: draftId,
        deliveredSignature: getTelegramRenderedPartSignature(part),
      };
    } catch (error) {
      if (!allowPlainFallback || !isTelegramBadRequestError(error)) throw error;
      logger.warn("[Bot] Native thinking draft failed, falling back to plain reasoning text", error);
      const sentMessage = await api.sendMessage(chatId, part.fallbackText, rawOptions);
      return {
        messageId: sentMessage.message_id,
        deliveredSignature: plainSignature(part.fallbackText),
        degradedToPlain: true,
      };
    }
  }

  if (isPlainPart(part)) {
    const sentMessage = await api.sendMessage(
      chatId,
      part.fallbackText,
      withPlainEntities(rawOptions, part),
    );
    return {
      messageId: sentMessage.message_id,
      deliveredSignature: plainSignature(part.fallbackText, part.entities),
    };
  }

  try {
    const sentMessage = await api.sendRichMessage(
      chatId,
      toInputRichMessage(part),
      rawOptions as TelegramSendRichOptions,
    );

    return {
      messageId: sentMessage.message_id,
      deliveredSignature: getTelegramRenderedPartSignature(part),
    };
  } catch (error) {
    if (!allowPlainFallback || !isTelegramBadRequestError(error)) {
      throw error;
    }

    logger.warn(
      "[Bot] Native rich blocks were rejected, retrying with source-preserving Rich HTML",
      error,
    );

    try {
      const sentMessage = await api.sendRichMessage(
        chatId,
        {
          html: buildSourcePreservingRichHtml(part.fallbackText, {
            preformatted: isCodeOnlyPart(part),
          }),
          ...(!isCodeOnlyPart(part) && shouldRenderRtl(part.fallbackText) ? { is_rtl: true } : {}),
        },
        rawOptions as TelegramSendRichOptions,
      );

      if (sentMessage && typeof sentMessage.message_id === "number") {
        return {
          messageId: sentMessage.message_id,
          deliveredSignature: getTelegramRenderedPartSignature(part),
        };
      }

      logger.warn(
        "[Bot] Source-preserving Rich HTML returned no message id, falling back to plain text",
      );
    } catch (richHtmlError) {
      if (!isTelegramBadRequestError(richHtmlError)) throw richHtmlError;
      logger.warn(
        "[Bot] Source-preserving Rich HTML was also rejected, falling back to plain text",
        richHtmlError,
      );
    }

    const chunks = chunkPlainText(part.fallbackText);
    let firstMessageId: number | null = null;
    for (const chunk of chunks) {
      const sentMessage = await api.sendMessage(chatId, chunk.fallbackText, rawOptions);
      firstMessageId ??= sentMessage.message_id;
    }

    if (firstMessageId === null) {
      throw error;
    }

    logger.debug("[Bot] Assistant message part sent in plain fallback mode", {
      fallbackTextLength: part.fallbackText.length,
      partCount: chunks.length,
    });

    return {
      messageId: firstMessageId,
      deliveredSignature: plainSignature(part.fallbackText),
      degradedToPlain: true,
    };
  }
}

async function persistThinkingDraftFinal(
  api: SendMessageApi,
  chatId: number,
  part: TelegramRenderedPart,
  options: TelegramEditMessageOptions | undefined,
): Promise<RenderedPartDeliveryResult> {
  const rawOptions = stripRichFormattingOptions(options as TelegramSendMessageOptions | undefined);

  if (isPlainPart(part)) {
    await api.sendMessage(chatId, part.fallbackText, withPlainEntities(rawOptions, part));
    return { deliveredSignature: plainSignature(part.fallbackText, part.entities) };
  }

  try {
    await api.sendRichMessage(
      chatId,
      toInputRichMessage(part),
      rawOptions as TelegramSendRichOptions,
    );
    return { deliveredSignature: getTelegramRenderedPartSignature(part) };
  } catch (error) {
    if (!isTelegramBadRequestError(error)) throw error;

    logger.warn("[Bot] Final rich reasoning send failed, retrying as plain text", error);
    const chunks = chunkPlainText(part.fallbackText);
    for (const chunk of chunks) {
      await api.sendMessage(chatId, chunk.fallbackText, rawOptions);
    }
    return {
      deliveredSignature: plainSignature(part.fallbackText),
      degradedToPlain: true,
    };
  }
}

export async function editRenderedBotPart({
  api,
  chatId,
  messageId,
  part,
  options,
  allowPlainFallback = true,
}: EditRenderedBotPartParams): Promise<RenderedPartDeliveryResult> {
  const rawOptions = stripRichFormattingOptions(options);

  logger.debug("[Bot] Editing rendered Telegram part", {
    messageId,
    source: part.source,
    blockCount: part.blocks.length,
    fallbackTextLength: part.fallbackText.length,
  });

  if (isActiveThinkingDraft(chatId, messageId)) {
    if (isThinkingPart(part) && hasRichDraftApi(api)) {
      await api.sendRichMessageDraft(
        chatId,
        messageId,
        toInputRichMessage(part),
        GENERATION_DRAFT_OPTIONS,
      );
      markThinkingDraft(chatId, messageId);
      return { deliveredSignature: getTelegramRenderedPartSignature(part) };
    }

    if (!hasSendMessageApi(api)) {
      throw new Error("Bot API cannot persist finalized native thinking draft");
    }

    consumeThinkingDraft(chatId, messageId);
    return persistThinkingDraftFinal(api, chatId, part, options);
  }

  // If draft transport is unavailable, a thinking block must degrade to plain
  // edit text because Telegram only accepts the native block in rich drafts.
  if (isThinkingPart(part)) {
    await api.editMessageText(chatId, messageId, part.fallbackText, rawOptions);
    return {
      deliveredSignature: plainSignature(part.fallbackText),
      degradedToPlain: true,
    };
  }

  if (isPlainPart(part)) {
    await api.editMessageText(
      chatId,
      messageId,
      part.fallbackText,
      withPlainEntities(rawOptions, part),
    );
    return {
      deliveredSignature: plainSignature(part.fallbackText, part.entities),
    };
  }

  try {
    await api.editMessageText(chatId, messageId, toInputRichMessage(part), rawOptions);

    return {
      deliveredSignature: getTelegramRenderedPartSignature(part),
    };
  } catch (error) {
    // An edit targets exactly one message, so there is nothing to split it
    // across; a plain retry is only possible when the text fits a message.
    if (
      !allowPlainFallback ||
      !isTelegramBadRequestError(error) ||
      part.fallbackText.length > TELEGRAM_TEXT_MESSAGE_LIMIT
    ) {
      throw error;
    }

    logger.warn("[Bot] Rich message edit failed, retrying assistant edit as plain text", error);
    await api.editMessageText(chatId, messageId, part.fallbackText, rawOptions);
    logger.debug("[Bot] Assistant edit part applied in plain fallback mode", {
      messageId,
      fallbackTextLength: part.fallbackText.length,
    });
    return {
      deliveredSignature: plainSignature(part.fallbackText),
      degradedToPlain: true,
    };
  }
}

interface SendDraftBotPartParams {
  api: SendDraftApi;
  chatId: Parameters<SendDraftApi["sendMessageDraft"]>[0];
  draftId: number;
  part: TelegramRenderedPart;
}

interface CompleteDraftPartParams {
  api: CompleteDraftApi;
  chatId: Parameters<CompleteDraftApi["sendMessage"]>[0];
  part: TelegramRenderedPart;
  options?: TelegramSendMessageOptions;
}

export async function sendDraftBotPart({
  api,
  chatId,
  draftId,
  part,
}: SendDraftBotPartParams): Promise<RenderedPartDeliveryResult> {
  logger.debug("[Bot] Sending draft part", {
    draftId,
    source: part.source,
    blockCount: part.blocks.length,
  });

  if (isPlainPart(part)) {
    await api.sendMessageDraft(
      chatId,
      draftId,
      part.fallbackText,
      GENERATION_DRAFT_OPTIONS,
    );
    return {
      deliveredSignature: plainSignature(part.fallbackText),
    };
  }

  await api.sendRichMessageDraft(
    chatId,
    draftId,
    toInputRichMessage(part),
    GENERATION_DRAFT_OPTIONS,
  );
  return {
    deliveredSignature: getTelegramRenderedPartSignature(part),
  };
}

function createMessageRollback(
  api: Pick<Api<RawApi>, "deleteMessage">,
  chatId: Parameters<Api<RawApi>["deleteMessage"]>[0],
  messageId: number,
): () => Promise<void> {
  return async () => {
    await api.deleteMessage(chatId, messageId);
  };
}

export async function completeDraftPart({
  api,
  chatId,
  part,
  options,
}: CompleteDraftPartParams): Promise<RenderedPartCompleteResult> {
  const rawOptions = stripRichFormattingOptions(options);

  logger.debug("[Bot] Completing draft with real message", {
    source: part.source,
    blockCount: part.blocks.length,
  });

  if (isPlainPart(part)) {
    const sentMessage = await api.sendMessage(chatId, part.fallbackText, rawOptions);
    return {
      messageId: sentMessage.message_id,
      deliveredSignature: plainSignature(part.fallbackText),
      rollback: createMessageRollback(api, chatId, sentMessage.message_id),
    };
  }

  const sentMessage = await api.sendRichMessage(
    chatId,
    toInputRichMessage(part),
    rawOptions as TelegramSendRichOptions,
  );
  return {
    messageId: sentMessage.message_id,
    deliveredSignature: getTelegramRenderedPartSignature(part),
    rollback: createMessageRollback(api, chatId, sentMessage.message_id),
  };
}

export async function editBotText({
  api,
  chatId,
  messageId,
  text,
  rawFallbackText,
  options,
  format = "raw",
}: EditBotTextParams): Promise<void> {
  await editMessageWithMarkdownFallback({
    api,
    chatId,
    messageId,
    text,
    rawFallbackText,
    options,
    parseMode: resolveParseMode(format),
  });
}
