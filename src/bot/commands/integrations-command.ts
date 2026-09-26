import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { addGithubAccount, getActiveGithubAccount, listGithubAccounts, removeGithubAccount, setActiveGithubAccount } from "../../app/services/github-integration-service.js";
import { addRailwayAccount, getActiveRailwayAccount, listRailwayAccounts, removeRailwayAccount, setActiveRailwayAccount, validateRailwayToken, type RailwayTokenValidation } from "../../app/services/railway-integration-service.js";
import { configureTailscale, disconnectTailscale, getTailscaleRuntimeStatus, listTailscaleDevices, reconnectTailscale, removeTailscaleIntegration } from "../../app/services/tailscale-integration-service.js";
import { getManagedSshPublicKey } from "../../app/services/ssh-key-service.js";
import { clearProviderWizard } from "./providers-command.js";
import { buildAdvancedSettingsView } from "../menus/settings-menu.js";
import { appendHomeNavigation, replyWithInlineMenu } from "../menus/inline-menu.js";
import { logger } from "../../utils/logger.js";
import { TopicScopedValue } from "../../app/services/topic-scoped-value.js";
import { getMainNavigationMessageId } from "../../app/stores/settings-store.js";
interface PendingGithub { step: "name" | "token"; name?: string; messageId: number; }
interface PendingRailway { step: "name" | "token"; name?: string; messageId: number; }
interface PendingTailscale { step: "auth-key"; messageId: number; }
interface PendingState { github?: PendingGithub; railway?: PendingRailway; tailscale?: PendingTailscale; }

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
  return Boolean(pending?.github || pending?.railway || pending?.tailscale);
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
  const tailscale = await getTailscaleRuntimeStatus();
  const keyboard = new InlineKeyboard().text("➕ Add GitHub account", "integration:github:add").text("➕ Add Railway account", "integration:railway:add");
  for (const account of githubAccounts) {
    const label = account.id === githubActive?.id ? `✅ ${account.name}` : account.name;
    keyboard.row().text(label, `integration:github:select:${account.id}`).text("🗑️", `integration:github:remove:${account.id}`);
  }
  for (const account of railwayAccounts) {
    const label = account.id === railwayActive?.id ? `✅ ${account.name}` : account.name;
    keyboard.row().text(label, `integration:railway:select:${account.id}`).text("🗑️", `integration:railway:remove:${account.id}`);
  }
  keyboard.row().text(`🌐 Tailscale · ${tailscale.connected ? "Connected" : tailscale.configured ? "Disconnected" : "Not set"}`, "integration:tailscale");
  keyboard.row().text("← Advanced", "integration:advanced").text("🏠 Home", "main:home");
  const body = `🔌 Integrations\n\nGitHub accounts: ${githubAccounts.length}\nActive: ${githubActive?.name ?? "None"}\n\nRailway accounts: ${railwayAccounts.length}\nActive: ${railwayActive?.name ?? "None"}\n\nTailscale: ${tailscale.connected ? "🟢 Connected" : tailscale.configured ? "⚪ Disconnected" : "⚪ Not configured"}`;
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

async function showTailscaleMenu(ctx: Context, messageId?: number, notice?: string): Promise<void> {
  const status = await getTailscaleRuntimeStatus();
  const devices = status.configured ? await listTailscaleDevices().catch(() => []) : [];
  const eligibleDevices = devices.filter((device) => device.sshEligible);
  const keyboard = new InlineKeyboard();
  if (!status.configured) {
    keyboard.text("🔑 Connect Tailnet", "integration:tailscale:connect").row();
  } else {
    keyboard.text("🔄 Reconnect", "integration:tailscale:reconnect").text("⏸ Disconnect", "integration:tailscale:disconnect").row();
    keyboard.text("🖥 Tailnet Devices", "integration:tailscale:devices").text("🔑 Change Auth Key", "integration:tailscale:connect").row();
    keyboard.text("🔐 SSH Public Key", "integration:tailscale:ssh-key").text("🗑 Forget Tailnet", "integration:tailscale:remove").row();
  }
  keyboard.text("← Integrations", "integration:menu").text("🏠 Home", "main:home");

  const body = [
    "🌐 Tailscale",
    "",
    `Status: ${status.connected ? "🟢 Connected" : status.configured ? "⚪ Disconnected" : "⚪ Not configured"}`,
    `Device: ${status.hostname}`,
    ...(status.tailnet ? [`Tailnet: ${status.tailnet}`] : []),
    ...(status.ips.length ? [`IP: ${status.ips.join(", ")}`] : []),
    `Mode: Userspace · persistent identity`,
    `Visible peers: ${status.visiblePeers}`,
    `SSH eligible: ${eligibleDevices.length}`,
    ...(status.selfTags.length ? [`Bot tags: ${status.selfTags.join(" · ")}`] : ["Bot tags: none"]),
    "",
    "Railway uses one shared tailscaled daemon and a persistent node identity, so the machine stays opencode-bot across restarts.",
    "SSH is Tailnet-only. A remote machine must join this Tailnet and carry tag:ssh before the model can access it.",
  ].join("\n");
  const text = notice ? `${notice}\n\n${body}` : body;
  const targetMessageId = callbackMessageId(ctx) ?? messageId ?? null;
  if (targetMessageId !== null && ctx.chat?.id) {
    try { await ctx.api.editMessageText(ctx.chat.id, targetMessageId, text, { reply_markup: keyboard }); }
    catch (error) { if (!/message is not modified/i.test(error instanceof Error ? error.message : String(error))) throw error; }
    return;
  }
  await ctx.reply(text, { reply_markup: keyboard });
}

async function showTailscaleDevices(ctx: Context): Promise<void> {
  const devices = await listTailscaleDevices();
  const text = [
    "🖥 Tailnet Devices",
    "",
    devices.length ? devices.map((device) => {
      const eligibility = device.sshEligible
        ? "✅ SSH eligible"
        : device.sshReason === "offline"
          ? "⚪ SSH blocked: device offline"
          : "❌ SSH blocked: missing tag:ssh";
      const auth = device.nativeTailscaleSsh
        ? "Auth: Native Tailscale SSH"
        : "Auth: Managed SSH key over Tailscale";
      return `${device.online ? "🟢" : "⚪"} ${device.name}\n   ${device.ips.join(", ") || "No IP"}\n   OS: ${device.os ?? "unknown"}\n   ${device.tags.length ? device.tags.join(" · ") : "No tags"}\n   ${auth}\n   ${eligibility}`;
    }).join("\n\n") : "No peers are visible in the bot's Tailscale netmap.",
    "",
    devices.length
      ? "SSH remains restricted to online devices carrying tag:ssh."
      : "If other devices exist in the tailnet, check the access policy: Tailscale netmap trimming only exposes peers this bot is allowed to communicate with.",
  ].join("\n");
  const keyboard = new InlineKeyboard().text("🔄 Refresh", "integration:tailscale:devices").row().text("← Tailscale", "integration:tailscale").text("🏠 Home", "main:home");
  const messageId = callbackMessageId(ctx);
  if (messageId !== null && ctx.chat?.id) {
    await ctx.api.editMessageText(ctx.chat.id, messageId, text, { reply_markup: keyboard }).catch((error) => {
      if (!/message is not modified/i.test(error instanceof Error ? error.message : String(error))) throw error;
    });
  }
}
export async function handleIntegrationsCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("integration:")) return false;
  const chatId = ctx.chat?.id;
  if (!chatId) return true;
  if (data === "integration:close") { clearIntegrationWizard(); clearProviderWizard(); await ctx.answerCallbackQuery({ text: "Closed" }).catch(() => {}); await ctx.deleteMessage().catch(() => {}); return true; }
  if (data === "integration:advanced") { clearIntegrationWizard(); clearProviderWizard(); await ctx.answerCallbackQuery().catch(() => {}); const view = buildAdvancedSettingsView(); await replyWithInlineMenu(ctx, { menuKind: "settings", text: view.text, keyboard: view.keyboard }); return true; }
  await ctx.answerCallbackQuery().catch(() => {});
  if (data === "integration:cancel") { const state = integrationWizard.get(); clearIntegrationWizard(); clearProviderWizard(); const id = state?.github?.messageId ?? state?.railway?.messageId ?? state?.tailscale?.messageId; if (state?.tailscale) await showTailscaleMenu(ctx, id, "❌ Setup cancelled."); else await showIntegrationsMenu(ctx, id, "❌ Setup cancelled."); return true; }
  if (data === "integration:menu") { clearIntegrationWizard(); clearProviderWizard(); await showIntegrationsMenu(ctx); return true; }
  if (data === "integration:tailscale") { clearIntegrationWizard(); clearProviderWizard(); await showTailscaleMenu(ctx); return true; }
  if (data === "integration:tailscale:devices") { clearIntegrationWizard(); await showTailscaleDevices(ctx); return true; }
  if (data === "integration:tailscale:ssh-key") {
    clearIntegrationWizard();
    const key = await getManagedSshPublicKey();
    const id = callbackMessageId(ctx);
    if (id !== null && ctx.chat?.id) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        id,
        `🔐 Bot SSH Public Key\n\n${key}\n\nUse this only for devices without native Tailscale SSH. Add it to the target OS user's authorized_keys file.\n\nNever copy or expose the bot private key.`,
        { reply_markup: new InlineKeyboard().text("← Tailscale", "integration:tailscale").text("🏠 Home", "main:home") },
      );
    }
    return true;
  }
  if (data === "integration:tailscale:connect") { const messageId = callbackMessageId(ctx); if (messageId === null) return true; clearProviderWizard(); integrationWizard.set({ tailscale: { step: "auth-key", messageId } }); await editWizard(ctx, messageId, "🌐 Connect Tailscale\n\nSend a Tailscale auth key.\n\nRequired key settings:\n• Reusable: ON\n• Tag: tag:opencode-bot\n• Ephemeral: OFF\n\nThe bot keeps one persistent Tailscale identity so the machine name and Tailscale IP remain stable across Railway restarts.\n\n🔒 The message will be deleted immediately. The key is encrypted in persistent bot state and is never exposed to the model."); return true; }
  if (data === "integration:tailscale:reconnect") { await reconnectTailscale(); await showTailscaleMenu(ctx, undefined, "✅ Tailscale reconnected."); return true; }
  if (data === "integration:tailscale:disconnect") { await disconnectTailscale(); await showTailscaleMenu(ctx, undefined, "⏸ Tailscale disconnected. The Tailnet identity is preserved."); return true; }
  if (data === "integration:tailscale:remove") { const id = callbackMessageId(ctx); if (id !== null && ctx.chat?.id) await ctx.api.editMessageText(ctx.chat.id, id, "🗑 Forget Tailscale?\n\nThis logs the bot out of the Tailnet and removes the encrypted auth key from bot state.", { reply_markup: new InlineKeyboard().text("🗑 Forget", "integration:tailscale:remove:confirm").text("Cancel", "integration:tailscale") }); return true; }
  if (data === "integration:tailscale:remove:confirm") { await removeTailscaleIntegration(); await showTailscaleMenu(ctx, undefined, "✅ Tailscale configuration removed."); return true; }
  if (data === "integration:github:add") { const messageId = callbackMessageId(ctx); if (messageId === null) { await ctx.answerCallbackQuery({ text: "This menu has expired. Please open Integrations again.", show_alert: true }).catch(() => {}); return true; } clearProviderWizard(); integrationWizard.set({ github: { step: "name", messageId } }); await editWizard(ctx, messageId, "➕ Add GitHub Account\n\n1/2 · Account name\n\nExample: Personal GitHub"); return true; }
  if (data === "integration:railway:add") { const messageId = callbackMessageId(ctx); if (messageId === null) { await ctx.answerCallbackQuery({ text: "This menu has expired. Please open Integrations again.", show_alert: true }).catch(() => {}); return true; } clearProviderWizard(); integrationWizard.set({ railway: { step: "name", messageId } }); await editWizard(ctx, messageId, "➕ Add Railway Account\n\n1/2 · Account name\n\nExample: Personal Railway"); return true; }
  if (data.startsWith("integration:github:select:")) { const account = await setActiveGithubAccount(data.slice("integration:github:select:".length)); await ctx.answerCallbackQuery({ text: `Active: ${account.name}` }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  if (data.startsWith("integration:github:remove:")) { const removed = await removeGithubAccount(data.slice("integration:github:remove:".length)); await ctx.answerCallbackQuery({ text: removed ? "GitHub account removed" : "GitHub account not found" }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  if (data.startsWith("integration:railway:select:")) { const account = await setActiveRailwayAccount(data.slice("integration:railway:select:".length)); await ctx.answerCallbackQuery({ text: `Active: ${account.name}` }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  if (data.startsWith("integration:railway:remove:")) { const removed = await removeRailwayAccount(data.slice("integration:railway:remove:".length)); await ctx.answerCallbackQuery({ text: removed ? "Railway account removed" : "Railway account not found" }).catch(() => {}); await showIntegrationsMenu(ctx); return true; }
  return true;
}
export async function handleIntegrationMessage(ctx: Context): Promise<boolean> {
  const text = ctx.message?.text?.trim();
  const state = integrationWizard.get();
  if (!ctx.chat?.id || !text || !state) return false;
  const github = state.github;
  const railway = state.railway;
  const tailscale = state.tailscale;
  try {
    if (github) {
      if (github.step === "name") { github.name = text; github.step = "token"; await deleteInput(ctx); await editWizard(ctx, github.messageId, "➕ Add GitHub Account\n\n2/2 · Personal Access Token\n\nSend the token as a message. Telegram will delete it when possible."); return true; }
      await deleteInput(ctx); const account = await addGithubAccount(github.name!, text); await finishWizard(ctx, github.messageId, `✅ GitHub account “${account.name}” added and selected.`); return true;
    }
    if (tailscale) {
      await deleteInput(ctx);
      await editWizard(ctx, tailscale.messageId, "🌐 Connecting Tailscale…\n\nStarting userspace networking and verifying Tailnet authentication.");
      await configureTailscale(text);
      clearIntegrationWizard();
      await showTailscaleMenu(ctx, tailscale.messageId, "✅ Tailscale connected.");
      return true;
    }
    if (railway) {
      if (railway.step === "name") { railway.name = text; railway.step = "token"; await deleteInput(ctx); await editWizard(ctx, railway.messageId, "➕ Add Railway Account\n\n2/2 · API Token\n\nSend the token as a message. It will be verified with Railway before it is saved."); return true; }
      await deleteInput(ctx); const validation = await validateRailwayToken(text);
      if (!validation.valid) { await editWizard(ctx, railway.messageId, `➕ Add Railway Account\n\n2/2 · API Token\n\n❌ ${railwayValidationError(validation).message}\n\nThe token was not saved. Send a valid token to retry, or press Cancel.`); return true; }
      const account = await addRailwayAccount(railway.name!, text, validation.tokenType!); await finishWizard(ctx, railway.messageId, `${railwayValidationSuccess(validation)}\n\n✅ Railway account “${account.name}” added and selected.`); return true;
    }
    return false;
  } catch (error) {
    logger.error("[Integrations] wizard failed:", error);
    const messageId = github?.messageId ?? railway?.messageId ?? tailscale?.messageId; const kind = github ? "GitHub" : railway ? "Railway" : "Tailscale";
    if (messageId !== undefined && integrationWizard.get()) await editWizard(ctx, messageId, kind === "Tailscale" ? `🌐 Connect Tailscale\n\n❌ ${error instanceof Error ? error.message : "Unknown error"}\n\nThe key was not saved. Send a valid auth key to retry, or press Cancel.` : `➕ Add ${kind} Account\n\n2/2 · Token\n\n❌ ${error instanceof Error ? error.message : "Unknown error"}\n\nSend the token again to retry, or press Cancel.`).catch(() => {});
    return true;
  }
}
async function finishWizard(ctx: Context, messageId: number, notice: string): Promise<void> { await deleteInput(ctx); try { await showIntegrationsMenu(ctx, messageId, notice); } finally { clearIntegrationWizard(); } }
