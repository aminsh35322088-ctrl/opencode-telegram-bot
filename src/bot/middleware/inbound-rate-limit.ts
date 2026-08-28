import type { Context } from "grammy";

interface Bucket { timestamps: number[]; lastNoticeAt: number; }

const WINDOW_MS = 10_000;
const MAX_UPDATES = 30;
const NOTICE_COOLDOWN_MS = 15_000;
const buckets = new Map<number, Bucket>();

export async function inboundRateLimitMiddleware(ctx: Context, next: () => Promise<unknown>): Promise<unknown> {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!chatId) return next();

  const now = Date.now();
  const bucket = buckets.get(chatId) ?? { timestamps: [], lastNoticeAt: 0 };
  bucket.timestamps = bucket.timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);

  if (bucket.timestamps.length >= MAX_UPDATES) {
    buckets.set(chatId, bucket);
    if (now - bucket.lastNoticeAt >= NOTICE_COOLDOWN_MS) {
      bucket.lastNoticeAt = now;
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Too many requests. Please slow down." }).catch(() => {});
      } else if (ctx.chat) {
        await ctx.reply("⏳ Too many requests. Please slow down.").catch(() => {});
      }
    }
    return;
  }

  bucket.timestamps.push(now);
  buckets.set(chatId, bucket);
  return next();
}

export function clearInboundRateLimitState(): void {
  buckets.clear();
}
