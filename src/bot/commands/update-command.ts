import { Context } from "grammy";
import { getBotUpdateNotice, getOpenCodeVersion, BOT_VERSION, markBotVersionNotified } from "../../app/services/version-info-service.js";

const RELEASE_VERSION_URL = "https://raw.githubusercontent.com/aminsh35322088-ctrl/opencode-telegram-bot/main/.opencode-version";

async function readLatestOpenCodeVersion(): Promise<string | null> {
  try {
    const response = await fetch(RELEASE_VERSION_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const version = (await response.text()).trim();
    return version || null;
  } catch {
    return null;
  }
}

async function sendBotUpdateNotice(ctx: Context): Promise<void> {
  const notice = await getBotUpdateNotice();
  if (!notice) return;

  await ctx.reply(
    `🚀 Bot updated\n\nv${notice.previousVersion} → <b>v${notice.currentVersion}</b>\n\n🟢 The new Telegram Bot version is installed and ready to use.`,
    { parse_mode: "HTML" },
  );

  if (notice.changelog) {
    await ctx.reply(`📋 Changelog v${notice.currentVersion}\n\n${notice.changelog}`);
  }

  await markBotVersionNotified(notice.currentVersion);
}

export async function updateCommand(ctx: Context): Promise<void> {
  await sendBotUpdateNotice(ctx);

  const current = await getOpenCodeVersion();
  const latest = await readLatestOpenCodeVersion();
  const botLine = `🤖 Telegram Bot: <b>v${BOT_VERSION}</b>`;

  if (!latest) {
    await ctx.reply(`🔄 Version Update\n\n${botLine}\n🧠 OpenCode: <b>v${current}</b>\n\n⚠️ Could not check the latest OpenCode version right now. Automatic updates remain enabled.`, { parse_mode: "HTML" });
    return;
  }

  if (latest === current) {
    await ctx.reply(`🟢 Everything is up to date\n\n${botLine}\n🧠 OpenCode: <b>v${current}</b>\n\nAutomatic OpenCode updates are enabled.`, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(
    `🚀 OpenCode update available\n\n${botLine}\n🧠 Current: <b>v${current}</b>\n🆕 Latest: <b>v${latest}</b>\n\nThe automatic updater will install the latest stable OpenCode version on its next update cycle.`,
    { parse_mode: "HTML" },
  );
}
