import { Context } from "grammy";
import { readFile } from "node:fs/promises";

const VERSION_FILE = "/app/.opencode-version";
const RELEASE_VERSION_URL = "https://raw.githubusercontent.com/aminsh35322088-ctrl/opencode-telegram-bot/main/.opencode-version";

async function readCurrentVersion(): Promise<string> {
  try {
    return (await readFile(VERSION_FILE, "utf8")).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function readLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(RELEASE_VERSION_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const version = (await response.text()).trim();
    return version || null;
  } catch {
    return null;
  }
}

export async function updateCommand(ctx: Context): Promise<void> {
  const current = await readCurrentVersion();
  const latest = await readLatestVersion();

  if (!latest) {
    await ctx.reply(`🔄 OpenCode Update\n\nCurrent version: ${current}\n\n⚠️ Could not check the latest version right now. Automatic updates remain enabled.`);
    return;
  }

  if (latest === current) {
    await ctx.reply(`🟢 OpenCode is up to date\n\nVersion: ${current}\n\nAutomatic updates are enabled.`);
    return;
  }

  await ctx.reply(
    `🚀 OpenCode update available\n\nCurrent: ${current}\nLatest:  ${latest}\n\nThe automatic updater will install the latest stable version on its next update cycle.`,
  );
}
