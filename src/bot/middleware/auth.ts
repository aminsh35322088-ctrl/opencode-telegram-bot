import { Context, NextFunction } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;
  const allowedUserId = config.telegram.allowedUserId;

  logger.debug(
    `[Auth] Checking access: userId=${userId}, allowedUserId=${allowedUserId}, hasCallbackQuery=${!!ctx.callbackQuery}, hasMessage=${!!ctx.message}`,
  );

  if (userId === allowedUserId) {
    logger.debug(`[Auth] Access granted for userId=${userId}`);
    await next();
    return;
  }

  // Single-user deployment: unauthorized users are ignored and never enter
  // application state, queues, sessions, or AI request handling.
  logger.warn(`Unauthorized access attempt from user ID: ${userId}`);
}
