import { Context, InlineKeyboard } from "grammy";
import { AI_ROLE_LABELS, type AiRole, getAiRoleSelections, setAiRoleSelection } from "../../app/services/ai-role-selection-service.js";
import { getProviders, getProviderModels } from "../../app/services/model-selection-service.js";
import { listImageAiProviders } from "../../app/services/image-ai-provider-service.js";
import { getGroqSttConfig } from "../../app/services/custom-provider-service.js";
import { replyWithInlineMenu } from "../menus/inline-menu.js";

const ROOT = "role:root";
const ROLE_PREFIX = "role:select:";
const PICK_PREFIX = "role:pick:";
const BACK = "role:back";
const ROLES: AiRole[] = ["coding", "image", "video", "stt"];

function roleFromData(data: string): AiRole | null {
  const value = data.slice(ROLE_PREFIX.length) as AiRole;
  return ROLES.includes(value) ? value : null;
}

export function isAiRoleCallback(data: string): boolean {
  return data === ROOT || data === BACK || data.startsWith(ROLE_PREFIX) || data.startsWith(PICK_PREFIX);
}

export async function handleAiRoleCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!isAiRoleCallback(data)) return false;
  await ctx.answerCallbackQuery().catch(() => {});

  if (data === BACK) {
    await ctx.deleteMessage().catch(() => {});
    return true;
  }

  if (data === ROOT) {
    await renderRoles(ctx);
    return true;
  }

  if (data.startsWith(ROLE_PREFIX)) {
    const role = roleFromData(data);
    if (!role) return true;
    await renderRoleModels(ctx, role);
    return true;
  }

  const parts = data.slice(PICK_PREFIX.length).split(":");
  const role = parts[0] as AiRole | undefined;
  const index = Number.parseInt(parts[1] ?? "", 10);
  if (!role || !ROLES.includes(role) || !Number.isInteger(index) || index < 0) return true;

  if (role === "coding") {
    const providers = await getProviders();
    const flattened: Array<{ providerID: string; modelID: string }> = [];
    for (const provider of providers) {
      for (const model of await getProviderModels(provider.id)) flattened.push(model);
    }
    const selected = flattened[index];
    if (selected) await setAiRoleSelection(role, selected.providerID, selected.modelID);
  } else if (role === "image") {
    const providers = (await listImageAiProviders()).filter(p => p.active);
    const selected = providers[index];
    if (selected) await setAiRoleSelection(role, selected.id, selected.model);
  } else if (role === "stt") {
    const stt = await getGroqSttConfig();
    if (stt) await setAiRoleSelection(role, stt.apiUrl, stt.model);
  }

  await renderRoles(ctx, "✅ AI role selection updated.");
  return true;
}

async function renderRoles(ctx: Context, notice?: string): Promise<void> {
  const selected = await getAiRoleSelections();
  const keyboard = new InlineKeyboard();
  for (const role of ROLES) keyboard.text(`${AI_ROLE_LABELS[role]}${selected[role] ? " · ✅" : ""}`, `${ROLE_PREFIX}${role}`).row();
  keyboard.text("← Models", BACK);
  const lines = ROLES.map(role => {
    const item = selected[role];
    return `${AI_ROLE_LABELS[role]}\n${item ? `✅ ${item.providerID}/${item.modelID}` : "⚪ Not configured"}`;
  });
  await replyWithInlineMenu(ctx, { menuKind: "model", text: `${notice ? `${notice}\n\n` : ""}🎛️ AI Roles\n\nEach role has an independent selected model. The router chooses the role automatically.\n\n${lines.join("\n\n")}`, keyboard });
}

async function renderRoleModels(ctx: Context, role: AiRole): Promise<void> {
  const keyboard = new InlineKeyboard();
  const selected = await getAiRoleSelections();
  if (role === "coding") {
    const providers = await getProviders();
    const flattened: Array<{ providerID: string; modelID: string }> = [];
    for (const provider of providers) for (const model of await getProviderModels(provider.id)) flattened.push(model);
    flattened.forEach((model, index) => keyboard.text(`${selected.coding?.providerID === model.providerID && selected.coding.modelID === model.modelID ? "✅" : "💻"} ${model.providerID}/${model.modelID}`, `${PICK_PREFIX}${role}:${index}`).row());
  } else if (role === "image") {
    const providers = (await listImageAiProviders()).filter(p => p.active);
    providers.forEach((provider, index) => keyboard.text(`${selected.image?.providerID === provider.id ? "✅" : "🎨"} ${provider.name}/${provider.model}`, `${PICK_PREFIX}${role}:${index}`).row());
  } else if (role === "stt") {
    const stt = await getGroqSttConfig();
    if (stt) keyboard.text(`${selected.stt?.model === stt.model ? "✅" : "🎙️"} Groq/${stt.model}`, `${PICK_PREFIX}${role}:0`).row();
  } else {
    keyboard.text("⚪ No verified Video AI provider", `${PICK_PREFIX}${role}:0`).row();
  }
  keyboard.text("← AI Roles", ROOT);
  await replyWithInlineMenu(ctx, { menuKind: "model", text: `${AI_ROLE_LABELS[role]}\n\nChoose the model for this role. Only verified/active providers are shown.`, keyboard });
}
