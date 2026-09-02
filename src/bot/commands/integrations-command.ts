import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { addGithubAccount, getActiveGithubAccount, listGithubAccounts, removeGithubAccount, setActiveGithubAccount } from "../../app/services/github-integration-service.js";
import { addRailwayAccount, getActiveRailwayAccount, listRailwayAccounts, removeRailwayAccount, setActiveRailwayAccount } from "../../app/services/railway-integration-service.js";
import { clearProviderWizard } from "./providers-command.js";
import { buildAdvancedSettingsView } from "../menus/settings-menu.js";
import { replyWithInlineMenu } from "../menus/inline-menu.js";
import { logger } from "../../utils/logger.js";

interface PendingGithub { step: "name" | "token"; name?: string; messageId: number; }
interface PendingRailway { step: "name" | "token"; name?: string; messageId: number; }
interface PendingState { github?: PendingGithub; railway?: PendingRailway; }
const pending = new Map<number, PendingState>();
function callbackMessageId(ctx: Context): number | null { const message = ctx.callbackQuery?.message; if (!message || !("message_id" in message)) return null; return typeof message.message_id === "number" ? message.message_id : null; }
function wizardKeyboard(): InlineKeyboard { return new InlineKeyboard().text("❌ Cancel", "integration:cancel").text("← Integrations", "integration:menu"); }
export function isIntegrationWizardActive(chatId: number): boolean { return Boolean(pending.get(chatId)?.github || pending.get(chatId)?.railway); }
export function clearIntegrationWizard(chatId: number): void { pending.delete(chatId); }
async function deleteInput(ctx: Context): Promise<void> { const messageId = ctx.message?.message_id; if (ctx.chat?.id && messageId) await ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => {}); }
async function editWizard(ctx: Context, messageId: number, text: string): Promise<void> { await ctx.api.editMessageText(ctx.chat!.id, messageId, text, { reply_markup: wizardKeyboard() }); }
export async function showIntegrationsMenu(ctx: Context, messageId?: number, notice?: string): Promise<void> {
  const githubAccounts = await listGithubAccounts();
  const githubActive = await getActiveGithubAccount();
  const railwayAccounts = await listRailwayAccounts();
  const railwayActive = await getActiveRailwayAccount();
  const keyboard = new InlineKeyboard().text("➕ Add GitHub account", "integration:github:add").text("➕ Add Railway account", "integration:railway:add");
  for (const account of githubAccounts) { const label = account.id === githubActive?.id ? `✅ ${account.name}` : account.name; keyboard.row().text(label, `integration:github:select:${account.id}`).text("🗑️", `integration:github:remove:${account.id}`); }
  for (const account of railwayAccounts) { const label = account.id === railwayActive?.id ? `✅ ${account.name}` : account.name; keyboard.row().text(label, `integration:railway:select:${account.id}`).text("🗑️", `integration:railway:remove:${account.id}`); }
  keyboard.row().text("← Advanced", "integration:advanced").text("✖ Close", "integration:close");
  const body = `🔌 Integrations\n\nGitHub accounts: ${githubAccounts.length}\nActive: ${githubActive?.name ?? "None"}\n\nRailway accounts: ${railwayAccounts.length}\nActive: ${railwayActive?.name ?? "None"}`;
  const text = notice ? `${notice}\n\n${body}` : body;
  const targetMessageId = messageId ?? callbackMessageId(ctx);
  if (targetMessageId !== null && ctx.chat?.id) { await ctx.api.editMessageText(ctx.chat.id, targetMessageId, text, { reply_markup: keyboard }); return; }
  await ctx.reply(text, { reply_markup: keyboard });
}
export async function integrationsCommand(ctx: CommandContext<Context>): Promise<void> { const chatId = ctx.chat?.id; if (chatId) { clearIntegrationWizard(chatId); clearProviderWizard(chatId); } await showIntegrationsMenu(ctx as Context); }
export async function handleIntegrationsCallback(ctx: Context): Promise<boolean> { const data = ctx.callbackQuery?.data ?? ""; if (!data.startsWith("integration:")) return false; const chatId = ctx.chat?.id; if (!chatId) return true;
  if (data === "integration:close") { clearIntegrationWizard(chatId); clearProviderWizard(chatId); await ctx.answerCallbackQuery({ text: "Closed" }).catch(() => {}); await ctx.deleteMessage().catch(() => {}); return true; }
  if (data === "integration:advanced") { clearIntegrationWizard(chatId); clearProviderWizard(chatId); await ctx.answerCallbackQuery().catch(() => {}); const view = buildAdvancedSettingsView(); await replyWithInlineMenu(ctx, { menuKind: "settings", text: view.text, keyboard: view.keyboard }); return true; }
  await ctx.answerCallbackQuery().catch(() => {});
  if (data === "integration:cancel") { const state = pending.get(chatId); pending.delete(chatId); clearProviderWizard(chatId); await showIntegrationsMenu(ctx, state?.github?.messageId ?? state?.railway?.messageId); return true; }
  if (data === "integration:menu") { await showIntegrationsMenu(ctx); return true; }
  if (data === "integration:github:add") { const messageId = callbackMessageId(ctx); if (messageId === null) { await ctx.answerCallbackQuery({ text: "This menu has expired. Please open Integrations again.", show_alert: true }).catch(() => {}); return true; } clearProviderWizard(chatId); pending.set(chatId, { github: { step: "name", messageId } }); await editWizard(ctx, messageId, "➕ Add GitHub Account\n\n1/2 · Account name\n\nExample: Personal GitHub"); return true; }
  if (data === "integration:railway:add") { const messageId = callbackMessageId(ctx); if (messageId === null) { await ctx.answerCallbackQuery({ text: "This menu has expired. Please open Integrations again.", show_alert: true }).catch(() => {}); return true; } clearProviderWizard(chatId); pending.set(chatId, { railway: { step: "name", messageId } }); await editWizard(ctx, messageId, "➕ Add Railway Account\n\n1/2 · Account name\n\nExample: My Railway Project"); return true; }
  if (data.startsWith("integration:github:select:")) { const account = await setActiveGithubAccount(data.slice("integration:github:select:".length)); await ctx.answerCallbackQuery({ text: `Active: ${account.name}` }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  if (data.startsWith("integration:github:remove:")) { const removed = await removeGithubAccount(data.slice("integration:github:remove:".length)); await ctx.answerCallbackQuery({ text: removed ? "GitHub account removed" : "GitHub account not found" }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  if (data.startsWith("integration:railway:select:")) { const account = await setActiveRailwayAccount(data.slice("integration:railway:select:".length)); await ctx.answerCallbackQuery({ text: `Active: ${account.name}` }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  if (data.startsWith("integration:railway:remove:")) { const removed = await removeRailwayAccount(data.slice("integration:railway:remove:".length)); await ctx.answerCallbackQuery({ text: removed ? "Railway account removed" : "Railway account not found" }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  return true;
}
export async function handleIntegrationMessage(ctx: Context): Promise<boolean> { const chatId = ctx.chat?.id; const text = ctx.message?.text?.trim(); const state = chatId ? pending.get(chatId) : undefined; if (!chatId || !text || !state) return false;
  const github = state.github;
  const railway = state.railway;
  try {
    if (github) {
      if (github.step === "name") { github.name = text; github.step = "token"; await deleteInput(ctx); await editWizard(ctx, github.messageId, "➕ Add GitHub Account\n\n2/2 · Personal Access Token\n\nSend the token as a message. Telegram will delete it when possible."); return true; }
      const account = await addGithubAccount(github.name!, text);
      await finishWizard(ctx, chatId, github.messageId, `✅ GitHub account “${account.name}” added and selected.`);
      return true;
    }
    if (railway) {
      if (railway.step === "name") { railway.name = text; railway.step = "token"; await deleteInput(ctx); await editWizard(ctx, railway.messageId, "➕ Add Railway Account\n\n2/2 · API Token\n\nSend the token as a message. Telegram will delete it when possible."); return true; }
      const account = await addRailwayAccount(railway.name!, text);
      await finishWizard(ctx, chatId, railway.messageId, `✅ Railway account “${account.name}” added and selected.`);
      return true;
    }
    return false;
  } catch (error) { logger.error("[Integrations] wizard failed:", error); const messageId = github?.messageId ?? railway?.messageId; const kind = github ? "GitHub" : "Railway"; if (messageId !== undefined && pending.has(chatId)) { await editWizard(ctx, messageId, `➕ Add ${kind} Account\n\n2/2 · Token\n\n❌ ${error instanceof Error ? error.message : "Unknown error"}\n\nSend the token again to retry, or press Cancel.`).catch(() => {}); } return true; }
}

async function finishWizard(ctx: Context, chatId: number, messageId: number, notice: string): Promise<void> {
  await deleteInput(ctx);
  try {
    await showIntegrationsMenu(ctx, messageId, notice);
  } finally {
    pending.delete(chatId);
  }
}