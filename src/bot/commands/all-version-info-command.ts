import { Context } from "grammy";
import { formatVersionSnapshot, getVersionSnapshot } from "../../app/services/version-info-service.js";

export async function allVersionInfoCommand(ctx: Context): Promise<void> {
  const snapshot = await getVersionSnapshot();
  await ctx.reply(formatVersionSnapshot(snapshot), { parse_mode: "HTML" });
}
