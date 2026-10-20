import { InlineKeyboard } from "grammy";
import { requestInfrastructureSetup } from "../../control-plane/application-transport.js";
import { setTopicNodeCreationEnabled, topicNodeLifecycle } from "../../control-plane/topic-node-lifecycle.js";
import { normalizeRailwayWorkerSettings, type RailwayWorkerSettings } from "../../infrastructure/railway-worker-settings.js";
import { logger } from "../../utils/logger.js";
import { SETTINGS_BACK_CALLBACK, SETTINGS_RAILWAY_CALLBACK } from "./settings-menu.js";

export const SETTINGS_RAILWAY_CREATION_CALLBACK = `${SETTINGS_RAILWAY_CALLBACK}:creation`;
export const SETTINGS_RAILWAY_WARM_DEC_CALLBACK = `${SETTINGS_RAILWAY_CALLBACK}:warm:dec`;
export const SETTINGS_RAILWAY_WARM_INC_CALLBACK = `${SETTINGS_RAILWAY_CALLBACK}:warm:inc`;
export const SETTINGS_RAILWAY_CAPACITY_DEC_CALLBACK = `${SETTINGS_RAILWAY_CALLBACK}:capacity:dec`;
export const SETTINGS_RAILWAY_CAPACITY_INC_CALLBACK = `${SETTINGS_RAILWAY_CALLBACK}:capacity:inc`;

interface RailwayStatus { configured: boolean; workspaceName?: string; workspaceId?: string }
function parseStatus(value: unknown): RailwayStatus {
  if (!value || typeof value !== "object") return { configured: false };
  const input = value as Record<string, unknown>;
  return {
    configured: input.configured === true,
    ...(typeof input.workspaceName === "string" ? { workspaceName: input.workspaceName } : {}),
    ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}),
  };
}

export async function getRailwayWorkerSettings(): Promise<RailwayWorkerSettings> {
  return normalizeRailwayWorkerSettings(await requestInfrastructureSetup("settings.get"));
}

export async function updateRailwayWorkerSettings(patch: Partial<RailwayWorkerSettings>): Promise<RailwayWorkerSettings> {
  const settings = normalizeRailwayWorkerSettings(await requestInfrastructureSetup("settings.update", { patch }));
  setTopicNodeCreationEnabled(settings.workerCreationEnabled);
  void topicNodeLifecycle.bootstrapPool(settings.workerCreationEnabled ? settings.warmCapacity : 0)
    .catch(error => logger.warn("[RailwaySettings] Worker pool reconciliation failed", error));
  return settings;
}

export async function buildRailwaySettingsView(settings?: RailwayWorkerSettings): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const current = settings ?? await getRailwayWorkerSettings();
  let railway: RailwayStatus = { configured: false };
  try { railway = parseStatus(await requestInfrastructureSetup("status")); } catch { /* settings remain usable */ }
  const workspace = railway.configured ? (railway.workspaceName ?? railway.workspaceId ?? "Connected") : "Not connected";
  return {
    text: [
      "🚂 <b>Railway</b>", "",
      `Workspace · <b>${workspace}</b>`,
      `Worker creation · <b>${current.workerCreationEnabled ? "ON" : "OFF"}</b>`,
      "Worker fleet · <b>4 maximum</b> (+ this Control Plane)",
      "Sleep policy · <b>Unassigned Workers only</b>", "";
      "A Worker assigned to a Topic stays awake even when its model is idle.",
      "Only a Worker with no Topic assignment may sleep. Its Railway Service and /data Volume are retained for reuse.",
      "The four-Worker fleet limit is fixed; capacity controls are managed by the Control Plane and cannot exceed this limit.",
    ].join("\n"),
    keyboard: new InlineKeyboard()
      .text(`Worker creation · ${current.workerCreationEnabled ? "ON" : "OFF"}`, SETTINGS_RAILWAY_CREATION_CALLBACK).row()
      .text("Fleet cap · 4 Workers", SETTINGS_RAILWAY_CALLBACK).row()
      .text("← Settings", SETTINGS_BACK_CALLBACK),
  };
}
