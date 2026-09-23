import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { addGithubAccount, getActiveGithubAccount, listGithubAccounts, removeGithubAccount, setActiveGithubAccount } from "../../app/services/github-integration-service.js";
import { addRailwayAccount, getActiveRailwayAccount, listRailwayAccounts, removeRailwayAccount, setActiveRailwayAccount, validateRailwayToken, type RailwayTokenValidation } from "../../app/services/railway-integration-service.js";
import { addCloudflareAccessAccount, getActiveCloudflareAccessAccount, listCloudflareAccessAccounts, removeCloudflareAccessAccount, setActiveCloudflareAccessAccount } from "../../app/services/cloudflare-integration-service.js";
import { clearProviderWizard } from "./providers-command.js";
import { buildAdvancedSettingsView } from "../menus/settings-menu.js";
import { appendHomeNavigation, replyWithInlineMenu } from "../menus/inline-menu.js";
import { logger } from "../../utils/logger.js";
import { TopicScopedValue } from "../../app/services/topic-scoped-value.js";
import { getMainNavigationMessageId } from "../../app/stores/settings-store.js";
interface PendingGithub { step: "name" | "token"; name?: string; messageId: number; }
interface PendingRailway { step: "name" | "token"; name?: string; messageId: number; }
interface PendingCloudflare { step: "name" | "clientId" | "clientSecret"; name?: string; clientId?: string; messageId: number; }
interface PendingState { github?: PendingGithub; railway?: PendingRailway; cloudflare?: PendingCloudflare; }

const integrationWizard = new TopicScopedValue<PendingState>();
function callbackMessageId(ctx: Context): number | null {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  if (typeof chatId === "number") {
    const canonical = getMainNavigationMessageId(chatId);
    if (typeof canonical === "number" && Number.isInteger(canonical) && canonical > 0) {
      return canonical;
    }
  }
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  return typeof message.message_id === "number" ? message.message_id : null;
}
function wizardKeyboard(): InlineKeyboard {
  return appendHomeNavigation(new InlineKeyboard().text("❌ Cancel", "integration:cancel").text("← Integrations", "integration:menu"));
}
export function isIntegrationWizardActive(): boolean {
  const pending = integrationWizard.get();
  return Boolean(pending?.github || pending?.railway || pending?.cloudflare);
}
export function clearIntegrationWizard(): void {
  integrationWizard.clear();
}
function railwayValidationError(validation: RailwayTokenValidation): Error {
  switch (validation.reason) {
    case "unauthorized": return new Error("Railway rejected this token (unauthorized). Check that it is active and copied correctly.");
    case "timeout": return new Error("Railway API validation timed out. Please try again.");
    case "network": return new Error("Could not reach the Railway API. Please try again in a moment.");
    case "api_error": return new Error("Railway API rejected the validation request. Please check the token type and try again.");
    default: return new Error("This Railway token could not be validated. Use a valid Account, Workspace, or Project token.");
  }
}
function railwayValidationSuccess(validation: RailwayTokenValidation): string {
  if (validation.tokenType === "project") return `✅ Token verified · Project token\nProject: ${validation.projectId}\nEnvironment: ${validation.environmentId}`;
  if (validation.tokenType === "workspace") return "✅ Token verified · Workspace token";
  const identity = [validation.subjectName, validation.subjectEmail].filter(Boolean).join(" · ");
  return `✅ Token verified · Account token${identity ? `\n${identity}` : ""}`;
}
async function deleteInput(ctx: Context): Promise<void> { const messageId = ctx.message?.message_id; if (ctx.chat?.id && messageId) await ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => {}); }
async function editWizard(ctx: Context, messageId: number, text: string): Promise<void> {
  try {
    await ctx.api.editMessageText(ctx.chat!.id, callbackMessageId(ctx) ?? messageId, text, { reply_markup: wizardKeyboard() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("message is not modified")) return;
    throw error;
  }
}
export async function showIntegrationsMenu(ctx: Context, messageId?: number, notice?: string): Promise<void> {
  const githubAccounts = await listGithubAccounts();
  const githubActive = await getActiveGithubAccount();
  const railwayAccounts = await listRailwayAccounts();
  const railwayActive = await getActiveRailwayAccount();
  const cloudflareAccounts = await listCloudflareAccessAccounts();
  const cloudflareActive = await getActiveCloudflareAccessAccount();
  const keyboard = new InlineKeyboard()
    .text("🐙 Add GitHub", "integration:github:add")
    .text("🚂 Add Railway", "integration:railway:add")
    .row()
    .text("☁️ Add Cloudflare SSH", "integration:cloudflare:add");
  for (const account of githubAccounts) {
    const label = account.id === githubActive?.id ? `✅ 🐙 ${account.name}` : `🐙 ${account.name}`;
    keyboard.row().text(label, `integration:github:select:${account.id}`).text("🗑️", `integration:github:remove:${account.id}`);
  }
  for (const account of railwayAccounts) {
    const label = account.id === railwayActive?.id ? `✅ 🚂 ${account.name}` : `🚂 ${account.name}`;
    keyboard.row().text(label, `integration:railway:select:${account.id}`).text("🗑️", `integration:railway:remove:${account.id}`);
  }
  for (const account of cloudflareAccounts) {
    const label = account.id === cloudflareActive?.id ? `✅ ☁️ ${account.name}` : `☁️ ${account.name}`;
    keyboard.row().text(label, `integration:cloudflare:select:${account.id}`).text("🗑️", `integration:cloudflare:remove:${account.id}`);
  }
  keyboard.row().text("← Advanced", "integration:advanced").text("🏠 Home", "main:home");
  const body = [
    "🔌 Integrations",
    "",
    `🐙 GitHub · ${githubAccounts.length} saved`,
    `Active: ${githubActive?.name ?? "None"}`,
    "",
    `🚂 Railway · ${railwayAccounts.length} saved`,
    `Active: ${railwayActive?.name ?? "None"}`,
    "",
    `☁️ Cloudflare SSH · ${cloudflareAccounts.length ? `${cloudflareAccounts.length} saved` : "Not configured"}`,
    `Active: ${cloudflareActive?.name ?? "None"}`,
    "Private SSH transport for Runner/VPS access.",
  ].join("\n");
  const text = notice ? `${notice}\n\n${body}` : body;
  const targetMessageId = callbackMessageId(ctx) ?? messageId ?? null;
  if (targetMessageId !== null && ctx.chat?.id) {
    try {
      await ctx.api.editMessageText(ctx.chat.id, targetMessageId, text, { reply_markup: keyboard });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("message is not modified")) throw error;
    }
    return;
  }
  await ctx.reply(text, { reply_markup: keyboard });
}
export async function integrationsCommand(ctx: CommandContext<Context>): Promise<void> { clearIntegrationWizard(); clearProviderWizard(); await showIntegrationsMenu(ctx as Context); }
export async function handleIntegrationsCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("integration:")) return false;
  const chatId = ctx.chat?.id;
  if (!chatId) return true;
  if (data === "integration:close") { clearIntegrationWizard(); clearProviderWizard(); await ctx.answerCallbackQuery({ text: "Closed" }).catch(() => {}); await ctx.deleteMessage().catch(() => {}); return true; }
  if (data === "integration:advanced") { clearIntegrationWizard(); clearProviderWizard(); await ctx.answerCallbackQuery().catch(() => {}); const view = buildAdvancedSettingsView(); await replyWithInlineMenu(ctx, { menuKind: "settings", text: view.text, keyboard: view.keyboard }); return true; }
  await ctx.answerCallbackQuery().catch(() => {});
  if (data === "integration:cancel") { const state = integrationWizard.get(); clearIntegrationWizard(); clearProviderWizard(); await showIntegrationsMenu(ctx, state?.github?.messageId ?? state?.railway?.messageId ?? state?.cloudflare?.messageId, "❌ Setup cancelled."); return true; }
  if (data === "integration:menu") { clearIntegrationWizard(); clearProviderWizard(); await showIntegrationsMenu(ctx); return true; }
  if (data === "integration:github:add") { const messageId = callbackMessageId(ctx); if (messageId === null) { await ctx.answerCallbackQuery({ text: "This menu has expired. Please open Integrations again.", show_alert: true }).catch(() => {}); return true; } clearProviderWizard(); integrationWizard.set({ github: { step: "name", messageId } }); await editWizard(ctx, messageId, "➕ Add GitHub Account\n\n1/2 · Account name\n\nExample: Personal GitHub"); return true; }
  if (data === "integration:railway:add") { const messageId = callbackMessageId(ctx); if (messageId === null) { await ctx.answerCallbackQuery({ text: "This menu has expired. Please open Integrations again.", show_alert: true }).catch(() => {}); return true; } clearProviderWizard(); integrationWizard.set({ railway: { step: "name", messageId } }); await editWizard(ctx, messageId, "➕ Add Railway Account\n\n1/2 · Account name\n\nExample: Personal Railway"); return true; }
  if (data === "integration:cloudflare:add") { const messageId = callbackMessageId(ctx); if (messageId === null) { await ctx.answerCallbackQuery({ text: "This menu has expired. Please open Integrations again.", show_alert: true }).catch(() => {}); return true; } clearProviderWizard(); integrationWizard.set({ cloudflare: { step: "name", messageId } }); await editWizard(ctx, messageId, "☁️ Cloudflare SSH\n\nStep 1 of 3 · Profile name\n\nA friendly name used only inside the bot.\nExample: Runner Lab"); return true; }
  if (data.startsWith("integration:github:select:")) { const account = await setActiveGithubAccount(data.slice("integration:github:select:".length)); await ctx.answerCallbackQuery({ text: `Active: ${account.name}` }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  if (data.startsWith("integration:github:remove:")) { const removed = await removeGithubAccount(data.slice("integration:github:remove:".length)); await ctx.answerCallbackQuery({ text: removed ? "GitHub account removed" : "GitHub account not found" }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  if (data.startsWith("integration:railway:select:")) { const account = await setActiveRailwayAccount(data.slice("integration:railway:select:".length)); await ctx.answerCallbackQuery({ text: `Active: ${account.name}` }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  if (data.startsWith("integration:railway:remove:")) { const removed = await removeRailwayAccount(data.slice("integration:railway:remove:".length)); await ctx.answerCallbackQuery({ text: removed ? "Railway account removed" : "Railway account not found" }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  if (data.startsWith("integration:cloudflare:select:")) { const account = await setActiveCloudflareAccessAccount(data.slice("integration:cloudflare:select:".length)); await ctx.answerCallbackQuery({ text: `Active: ${account.name}` }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  if (data.startsWith("integration:cloudflare:remove:")) { const removed = await removeCloudflareAccessAccount(data.slice("integration:cloudflare:remove:".length)); await ctx.answerCallbackQuery({ text: removed ? "Cloudflare Access account removed" : "Cloudflare Access account not found" }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  return true;
}
export async function handleIntegrationMessage(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  const state = integrationWizard.get();
  if (!ctx.chat?.id || !text || !state) return false;
  const github = state.github;
  const railway = state.railway;
  const cloudflare = state.cloudflare;
  try {
    if (github) {
      if (github.step === "name") { github.name = text; github.step = "token"; await deleteInput(ctx); await editWizard(ctx, github.messageId, "➕ Add GitHub Account\n\n2/2 · Personal Access Token\n\nSend the token as a message. Telegram will delete it when possible."); return true; }
      await deleteInput(ctx); const account = await addGithubAccount(github.name!, text); await finishWizard(ctx, github.messageId, `✅ GitHub account “${account.name}” added and selected.`); return true;
    }
    if (railway) {
      if (railway.step === "name") { railway.name = text; railway.step = "token"; await deleteInput(ctx); await editWizard(ctx, railway.messageId, "➕ Add Railway Account\n\n2/2 · API Token\n\nSend the token as a message. It will be verified with Railway before it is saved."); return true; }
      await deleteInput(ctx); const validation = await validateRailwayToken(text);
      if (!validation.valid) { await editWizard(ctx, railway.messageId, `➕ Add Railway Account\n\n2/2 · API Token\n\n❌ ${railwayValidationError(validation).message}\n\nThe token was not saved. Send a valid token to retry, or press Cancel.`); return true; }
      const account = await addRailwayAccount(railway.name!, text, validation.tokenType!); await finishWizard(ctx, railway.messageId, `${railwayValidationSuccess(validation)}\n\n✅ Railway account “${account.name}” added and selected.`); return true;
    }
    if (cloudflare) {
      if (cloudflare.step === "name") { cloudflare.name = text; cloudflare.step = "clientId"; await deleteInput(ctx); await editWizard(ctx, cloudflare.messageId, "☁️ Cloudflare SSH\n\nStep 2 of 3 · Service Token Client ID\n\nCloudflare Zero Trust → Access → Service Tokens\nSend the Client ID. Telegram will delete the message when possible."); return true; }
      if (cloudflare.step === "clientId") { cloudflare.clientId = text; cloudflare.step = "clientSecret"; await deleteInput(ctx); await editWizard(ctx, cloudflare.messageId, "☁️ Cloudflare SSH\n\nStep 3 of 3 · Client Secret\n\nSend the matching Service Token secret. Telegram will delete the message when possible."); return true; }
      await deleteInput(ctx); const account = await addCloudflareAccessAccount(cloudflare.name!, cloudflare.clientId!, text); await finishWizard(ctx, cloudflare.messageId, `✅ Cloudflare SSH profile “${account.name}” saved and selected.`); return true;
    }
    return false;
  } catch (error) {
    logger.error("[Integrations] wizard failed:", error);
    const messageId = github?.messageId ?? railway?.messageId ?? cloudflare?.messageId; const kind = github ? "GitHub" : railway ? "Railway" : "Cloudflare SSH";
    const credentialStep = cloudflare ? "Step 3 of 3 · Client Secret" : "2/2 · Token";
    if (messageId !== undefined && integrationWizard.get()) await editWizard(ctx, messageId, `➕ Add ${kind} Account\n\n${credentialStep}\n\n❌ ${error instanceof Error ? error.message : "Unknown error"}\n\nSend the credential again to retry, or press Cancel.`).catch(() => {});
    return true;
  }
}
async function finishWizard(ctx: Context, messageId: number, notice: string): Promise<void> { await deleteInput(ctx); try { await showIntegrationsMenu(ctx, messageId, notice); } finally { clearIntegrationWizard(); } }
