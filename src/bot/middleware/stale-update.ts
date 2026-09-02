import type { Context, NextFunction } from "grammy";
import { logger } from "../../utils/logger.js";

// Telegram keeps undelivered updates for up to 24 hours, so a message can reach
// the bot long after it was sent - after a restart, or after long polling was
// interrupted by a network outage. Acting on such a message is unwanted: it
// would start tasks the user no longer expects to run.
const MAX_MESSAGE_AGE_SECONDS = 60;
const SEEN_UPDATE_TTL_MS = 5 * 60 * 1000;
const seenUpdates = new Map<number, number>();
let lastSeenUpdateCleanup = 0;

function cleanupSeenUpdates(now: number): void {
  if (now - lastSeenUpdateCleanup < 30_000) return;
  lastSeenUpdateCleanup = now;
  for (const [updateId, seenAt] of seenUpdates) {
    if (now - seenAt >= SEEN_UPDATE_TTL_MS) seenUpdates.delete(updateId);
  }
}

export async function staleUpdateMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const now = Date.now();
  cleanupSeenUpdates(now);

  // `update_id` is globally unique within a Telegram bot's update stream. A
  // duplicate delivery must never execute commands twice (for example two
  // `/new` handlers creating two OpenCode sessions).
  const updateId = ctx.update.update_id;
  const seenAt = seenUpdates.get(updateId);
  if (seenAt !== undefined && now - seenAt < SEEN_UPDATE_TTL_MS) {
    logger.warn(`[UpdateGuard] Ignored duplicate update: updateId=${updateId}`);
    return;
  }
  seenUpdates.set(updateId, now);

  // Only `ctx.message` carries the time the user acted. `ctx.msg` also resolves
  // to `ctx.callbackQuery.message`, which is the bot's own message holding the
  // buttons - using it here would drop every press under an older message.
  const message = ctx.message;
  if (!message) {
    await next();
    return;
  }

  const ageSeconds = Math.floor(now / 1000) - message.date;
  if (ageSeconds <= MAX_MESSAGE_AGE_SECONDS) {
    await next();
    return;
  }

  logger.warn(
    `[StaleUpdate] Ignored stale message: ageSeconds=${ageSeconds}, updateId=${ctx.update.update_id}, messageId=${message.message_id}`,
  );
}

export function clearSeenUpdateState(): void {
  seenUpdates.clear();
  lastSeenUpdateCleanup = 0;
}
