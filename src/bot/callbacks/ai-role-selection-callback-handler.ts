import { Context, InlineKeyboard } from "grammy";
import { AI_ROLE_LABELS, type AiRole, getAiRoleSelections, setAiRoleSelection } from "../../app/services/ai-role-selection-service.js";
import { getProvidersForCapability, getProviderModelsForCapability } from "../../app/services/model-selection-service.js";
import { listImageAiProviders } from "../../app/services/image-ai-provider-service.js";
import { getGroqSttConfig } from "../../app/services/custom-provider-service.js";
import { replyWithInlineMenu } from "../menus/inline-menu.js";

const ROOT = "role:root";
const ROLE_PREFIX = "role:select:";
const PROVIDER_PREFIX = "role:provider:";
const PICK_PREFIX = "role:pick:";
const BACK = "role:back";
const ROLES: AiRole[] = ["coding", "image", "video", "stt"];

function roleFromData(data: string): AiRole | null {
  const value = data.slice(ROLE_PREFIX.length) as AiRole;
  return ROLES.includes(value) ? value : null;
}

export function isAiRoleCallback(data: string): boolean {
  return data === ROOT || data === BACK || data.startsWith(ROLE_PREFIX) || data.startsWith(PROVIDER_PREFIX) || data.startsWith(PICK_PREFIX);
}

interface CandidateProvider {
  id: string;
  name: string;
  models: Array<{ providerID: string; modelID: string }>;
}

async function providersForRole(role: AiRole): Promise<CandidateProvider[]> {
  if (role === "image") {
    return (await listImageAiProviders()).filter((provider) => provider.active).map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: [{ providerID: provider.id, modelID: provider.model }],
    }));
  }

  if (role === "stt") {
    const stt = await getGroqSttConfig();
    return stt ? [{ id: "groq", name: "Groq", models: [{ providerID: "groq", modelID: stt.model }] }] : [];
  }

  const providers = await getProvidersForCapability(role);
  const result: CandidateProvider[] = [];
  for (const provider of providers) {
    const models = await getProviderModelsForCapability(provider.id, role);
    if (models.length > 0) result.push({ id: provider.id, name: provider.name, models });
  }
  return result;
}

function selectedModelLabel(role: AiRole, selected: Awaited<ReturnType<typeof getAiRoleSelections>>): string {
  const item = selected[role];
  return item ? ` · ${item.modelID}` : "";
}

export async function showAiRulesMenu(ctx: Context, notice?: string): Promise<void> {
  await renderRoles(ctx, notice);
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
    await renderRoleProviders(ctx, role);
    return true;
  }
  if (data.startsWith(PROVIDER_PREFIX)) {
    const parts = data.slice(PROVIDER_PREFIX.length).split(":");
    const role = parts[0] as AiRole | undefined;
    const providerIndex = Number(parts[1]);
    if (!role || !ROLES.includes(role) || !Number.isInteger(providerIndex) || providerIndex < 0) return true;
    const providers = await providersForRole(role);
    if (!providers[providerIndex]) return true;
    await renderProviderModels(ctx, role, providerIndex);
    return true;
  }

  const parts = data.slice(PICK_PREFIX.length).split(":");
  const role = parts[0] as AiRole | undefined;
  const providerIndex = Number(parts[1]);
  const modelIndex = Number(parts[2]);
  if (!role || !ROLES.includes(role) || !Number.isInteger(providerIndex) || providerIndex < 0 || !Number.isInteger(modelIndex) || modelIndex < 0) return true;

  const providers = await providersForRole(role);
  const provider = providers[providerIndex];
  const selected = provider?.models[modelIndex];
  if (selected) {
    await setAiRoleSelection(role, selected.providerID, selected.modelID);
    await renderRoles(ctx, "✅ AI Rule updated.");
  }
  return true;
}

async function renderRoles(ctx: Context, notice?: string): Promise<void> {
  const selected = await getAiRoleSelections();
  const keyboard = new InlineKeyboard();
  for (const role of ROLES) {
    const model = selectedModelLabel(role, selected);
    keyboard.text(`${AI_ROLE_LABELS[role]}${model}`, `${ROLE_PREFIX}${role}`).row();
  }
  keyboard.text("← Back", BACK);
  const lines = ROLES.map((role) => {
    const item = selected[role];
    return `${AI_ROLE_LABELS[role]}\n${item ? `✅ ${item.providerID}/${item.modelID}` : "⚪ Not configured"}`;
  });
  await replyWithInlineMenu(ctx, {
    menuKind: "model",
    text: `${notice ? `${notice}\n\n` : ""}🧠 AI Rules\n\nChoose which provider/model each AI capability uses.\n\n${lines.join("\n\n")}`,
    keyboard,
  });
}

async function renderRoleProviders(ctx: Context, role: AiRole, notice?: string): Promise<void> {
  const selected = await getAiRoleSelections();
  const providers = await providersForRole(role);
  const keyboard = new InlineKeyboard();
  providers.forEach((provider, index) => {
    keyboard.text(`${selected[role]?.providerID === provider.id ? "✅" : "🔌"} ${provider.name}\n${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`, `${PROVIDER_PREFIX}${role}:${index}`).row();
  });
  keyboard.text("← AI Rules", ROOT);
  const body = providers.length ? "Choose a provider first. Its verified models will appear next." : `No verified ${AI_ROLE_LABELS[role]} providers are available.`;
  await replyWithInlineMenu(ctx, {
    menuKind: "model",
    text: `${notice ? `${notice}\n\n` : ""}${AI_ROLE_LABELS[role]}\n\n${body}`,
    keyboard,
  });
}

async function renderProviderModels(ctx: Context, role: AiRole, providerIndex: number): Promise<void> {
  const selected = await getAiRoleSelections();
  const providers = await providersForRole(role);
  const provider = providers[providerIndex];
  const keyboard = new InlineKeyboard();
  if (!provider) {
    keyboard.text("← Providers", `${ROLE_PREFIX}${role}`);
    await replyWithInlineMenu(ctx, { menuKind: "model", text: `${AI_ROLE_LABELS[role]}\n\n⚠️ Provider is no longer available.`, keyboard });
    return;
  }
  provider.models.forEach((model, index) => {
    const active = selected[role]?.providerID === model.providerID && selected[role]?.modelID === model.modelID;
    keyboard.text(`${active ? "✅" : "🤖"} ${model.modelID}`, `${PICK_PREFIX}${role}:${providerIndex}:${index}`).row();
  });
  keyboard.text("← Providers", `${ROLE_PREFIX}${role}`);
  await replyWithInlineMenu(ctx, {
    menuKind: "model",
    text: `${AI_ROLE_LABELS[role]} → ${provider.name}\n\nSelect a verified model.\n\nProvider: ${provider.name}`,
    keyboard,
  });
}