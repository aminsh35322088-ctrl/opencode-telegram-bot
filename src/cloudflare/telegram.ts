import { renderTelegramParts } from "../bot/render/pipeline.js";
import { shouldRenderRtl } from "../bot/render/text-direction.js";
export class TelegramDeliveryError extends Error {
  constructor(
    readonly category: "rate_limited" | "rejected" | "ambiguous",
    readonly retryAfter?: number,
    readonly transportCode?: "timeout" | "redirect" | "invocation" | "network",
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
      parameters?: { retry_after?: number };
    };
    if (!body.ok) {
      if (body.error_code === 429)
        throw new TelegramDeliveryError("rate_limited", body.parameters?.retry_after);
      throw new TelegramDeliveryError(response.status >= 500 ? "ambiguous" : "rejected");
    }
    return body.result as T;
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
