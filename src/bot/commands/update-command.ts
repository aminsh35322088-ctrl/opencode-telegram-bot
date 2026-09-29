import { Context } from "grammy";
import {
  getBotUpdateNotice,
  BOT_VERSION,
  markBotVersionNotified,
} from "../../app/services/version-info-service.js";
import { getCoreReleaseInfo } from "../../core/release-info.js";

interface GitHubReleaseResponse {
  tag_name?: unknown;
}

async function readLatestCoreTag(repository: string): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases/latest`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "opencode-telegram-bot",
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as GitHubReleaseResponse;
    return typeof payload.tag_name === "string" && payload.tag_name.trim()
      ? payload.tag_name.trim()
      : null;
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

  let release;
  try {
    release = await getCoreReleaseInfo();
  } catch {
    await ctx.reply(
      `🔄 Version Update\n\n🤖 Telegram Bot: <b>v${BOT_VERSION}</b>\n\n⚠️ The pinned Telegram Core release identity is unavailable.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const latestTag = await readLatestCoreTag(release.repository);
  const botLine = `🤖 Telegram Bot: <b>v${BOT_VERSION}</b>`;
  const coreLine = `🧩 Telegram Core: <b>${release.telegramCoreVersion}</b>`;
  const openCodeLine = `🧠 OpenCode: <b>v${release.upstreamVersion}</b>`;

  if (!latestTag) {
    await ctx.reply(
      `🔄 Version Update\n\n${botLine}\n${coreLine}\n${openCodeLine}\n\n⚠️ Could not check the latest Telegram Core release right now. The deployed runtime and SDK remain pinned to the verified Core release.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (latestTag === release.tag) {
    await ctx.reply(
      `🟢 Everything is up to date\n\n${botLine}\n${coreLine}\n${openCodeLine}\n\nRuntime, SDK, and native Core are pinned to the same verified release.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  await ctx.reply(
    `🚀 Telegram Core update available\n\n${botLine}\n${coreLine}\n${openCodeLine}\n\nCurrent Core tag: <b>${release.tag}</b>\nLatest Core tag: <b>${latestTag}</b>\n\nUpgrading requires moving the pinned Core release lock and redeploying after verification.`,
    { parse_mode: "HTML" },
  );
}
