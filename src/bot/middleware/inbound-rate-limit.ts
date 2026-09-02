import type { Context } from "grammy";

interface Bucket {
  timestamps: number[];
  lastNoticeAt: number;
}

const WINDOW_MS = 10_000;
const MAX_UPDATES = 30;
const NOTICE_COOLDOWN_MS = 15_000;
let bucket: Bucket = { timestamps: [], lastNoticeAt: 0 };

export async function inboundRateLimitMiddleware(
  ctx: Context,
  next: () => Promise<unknown>,
): Promise<unknown> {
  const now = Date.now();
  bucket.timestamps = bucket.timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);

  if (bucket.timestamps.length >= MAX_UPDATES) {
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
  return next();
}

export function clearInboundRateLimitState(): void {
  bucket = { timestamps: [], lastNoticeAt: 0 };
}
