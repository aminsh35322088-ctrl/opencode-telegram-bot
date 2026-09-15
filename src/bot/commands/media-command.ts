import type { Context } from "grammy";

/** Compatibility for commands saved in old Telegram menus. Image Topics are handled before this router. */
export async function imageCommand(ctx: Context): Promise<void> {
  await ctx.reply("Use 🎨 New Image Chat from Main to create and edit images.");
}
export const editCommand = imageCommand;
