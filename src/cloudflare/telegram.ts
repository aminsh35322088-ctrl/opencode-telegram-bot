import { renderTelegramParts } from "../bot/render/pipeline.js";
import { shouldRenderRtl } from "../bot/render/text-direction.js";
export class TelegramDeliveryError extends Error {
  constructor(
    readonly category: "rate_limited" | "rejected" | "ambiguous",
    readonly retryAfter?: number,
    readonly transportCode?: "timeout" | "redirect" | "invocation" | "network",
    readonly reason?: "message_not_found",
  ) {
    super("telegram_" + category + (transportCode ? "_" + transportCode : ""));
  }
}
/** Reuses the existing native block parser/chunker and RTL presentation. No model runtime. */
export class CloudTelegram {
  constructor(
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      const transport = this.transport;
      response = await transport("https://api.telegram.org/bot" + this.token + "/" + method, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
        redirect: "manual",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code =
        error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
          ? "timeout"
          : /redirect/i.test(message)
            ? "redirect"
            : /illegal invocation|receiver/i.test(message)
              ? "invocation"
              : "network";
      throw new TelegramDeliveryError("ambiguous", undefined, code);
    }
    if (response.status >= 300 && response.status < 400)
      throw new TelegramDeliveryError("ambiguous", undefined, "redirect");
    const body = (await response.json()) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!body.ok) {
      if (
        body.error_code === 400 &&
        ["editMessageText", "editMessageReplyMarkup"].includes(method) &&
        /^Bad Request: message is not modified(?:[:.]|$)/i.test(body.description ?? "")
      )
        return { message_id: payload.message_id } as T;
      if (
        body.error_code === 400 &&
        method === "editForumTopic" &&
        /^(?:Bad Request: )?TOPIC_NOT_MODIFIED$/i.test(body.description ?? "")
      )
        return true as T;
      if (
        body.error_code === 400 &&
        method === "editMessageText" &&
        /^Bad Request: message to edit not found$/i.test(body.description ?? "")
      )
        throw new TelegramDeliveryError("rejected", undefined, undefined, "message_not_found");
      if (
        method === "deleteForumTopic" &&
        body.error_code === 400 &&
        /TOPIC_NOT_FOUND|message thread not found/i.test(body.description ?? "")
      )
        return true as T;
      if (body.error_code === 429)
        throw new TelegramDeliveryError("rate_limited", body.parameters?.retry_after);
      throw new TelegramDeliveryError(response.status >= 500 ? "ambiguous" : "rejected");
    }
    return body.result as T;
  }
  async document(
    chatId: number,
    threadId: number,
    filename: string,
    content: string | Uint8Array,
  ): Promise<number> {
    if (content.length > 262144 || !/^[A-Za-z0-9_.-]{1,128}$/.test(filename))
      throw new Error("invalid_document");
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("message_thread_id", String(threadId));
    form.set(
      "document",
      new Blob([typeof content === "string" ? content : new Uint8Array(content).buffer], {
        type: typeof content === "string" ? "text/plain" : "application/octet-stream",
      }),
      filename,
    );
    const transport = this.transport;
    let response: Response;
    try {
      response = await transport("https://api.telegram.org/bot" + this.token + "/sendDocument", {
        method: "POST",
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new TelegramDeliveryError("ambiguous");
    }
    const result = (await response.json()) as {
      ok?: boolean;
      error_code?: number;
      parameters?: { retry_after?: number };
      result?: { message_id: number };
    };
    if (!result.ok)
      throw new TelegramDeliveryError(
        result.error_code === 429
          ? "rate_limited"
          : response.status >= 500
            ? "ambiguous"
            : "rejected",
        result.parameters?.retry_after,
      );
    return result.result!.message_id;
  }
  async download(fileId: string, maximum: number): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", {
      file_id: fileId,
    });
    if (
      typeof file.file_path !== "string" ||
      !/^[A-Za-z0-9_./-]{1,512}$/.test(file.file_path) ||
      file.file_path.startsWith("/") ||
      file.file_path.split("/").some((p) => p === ".." || p === ".")
    )
      throw new Error("invalid_telegram_file");
    if ((file.file_size ?? 0) > maximum) throw new Error("media_too_large");
    const transport = this.transport;
    const response = await transport(
      "https://api.telegram.org/file/bot" + this.token + "/" + file.file_path,
      { redirect: "error", signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok || !response.body) throw new Error("media_download_failed");
    if (Number(response.headers.get("content-length") ?? 0) > maximum)
      throw new Error("media_too_large");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > maximum) {
          await reader.cancel();
          throw new Error("media_too_large");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  async editPart(
    chatId: number,
    messageId: number,
    part: ReturnType<typeof renderTelegramParts>[number],
  ): Promise<number> {
    const scope = { chat_id: chatId, message_id: messageId };
    let result: { message_id: number };
    try {
      result = await this.call("editMessageText", {
        ...scope,
        rich_message: {
          blocks: part.blocks,
          ...(shouldRenderRtl(part.fallbackText) ? { is_rtl: true } : {}),
        },
      });
    } catch (error) {
      if (!(error instanceof TelegramDeliveryError) || error.category !== "rejected") throw error;
      result = await this.call("editMessageText", { ...scope, text: part.fallbackText });
    }
    return result.message_id;
  }
  async sendPart(
    chatId: number,
    threadId: number | undefined,
    part: ReturnType<typeof renderTelegramParts>[number],
  ): Promise<number> {
    const scope = { chat_id: chatId, ...(threadId ? { message_thread_id: threadId } : {}) };
    let result: { message_id: number };
    try {
      result = await this.call("sendRichMessage", {
        ...scope,
        rich_message: {
          blocks: part.blocks,
          ...(shouldRenderRtl(part.fallbackText) ? { is_rtl: true } : {}),
        },
      });
    } catch (error) {
      if (!(error instanceof TelegramDeliveryError) || error.category !== "rejected") throw error;
      result = await this.call("sendMessage", { ...scope, text: part.fallbackText });
    }
    return result.message_id;
  }
  async send(chatId: number, threadId: number | undefined, text: string): Promise<number[]> {
    const ids: number[] = [];
    for (const part of renderTelegramParts(text)) {
      ids.push(await this.sendPart(chatId, threadId, part));
    }
    return ids;
  }
}
