import path from "node:path";
import type { ModelInfo } from "../types/model.js";
import type { ProjectInfo } from "../types/project.js";
import type { SessionDirectoryCacheInfo, SessionInfo } from "../types/session.js";
import { cloneScheduledTask, type ScheduledTask } from "../types/scheduled-task.js";
import type { MessageFormatMode, ResponseStreamingMode, ScheduledTaskSessionIgnoreInfo, Settings } from "../types/settings.js";
import type { TopicDefaults, TopicSettings } from "../types/topic-settings.js";
import { config } from "../../config.js";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";
import { getTopicRuntimeContext } from "../services/topic-runtime-context.js";
import { getTopicRuntimeStateSync, updateTopicRuntimeStateSync } from "./topic-runtime-state-store.js";

function cloneScheduledTasks(tasks: ScheduledTask[] | undefined): ScheduledTask[] | undefined { return tasks?.map((task) => cloneScheduledTask(task)); }
function cloneScheduledTaskSessionIgnores(ignores: ScheduledTaskSessionIgnoreInfo[] | undefined): ScheduledTaskSessionIgnoreInfo[] | undefined { return ignores?.map((ignore) => ({ ...ignore })); }
function getSettingsFilePath(): string { return getRuntimePaths().settingsFilePath; }
function getSettingsBackupFilePath(): string { return `${getSettingsFilePath()}.bak`; }
function getSettingsTempFilePath(): string { return `${getSettingsFilePath()}.tmp`; }
let skipNextBackupRotation = false;
let settingsWriteQueue: Promise<void> = Promise.resolve();
function isFileNotFound(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
async function readSettingsFileAt(filePath: string): Promise<Settings> { const fs = await import("fs/promises"); return JSON.parse(await fs.readFile(filePath, "utf-8")) as Settings; }
async function readSettingsFile(): Promise<Settings> { const settingsFilePath = getSettingsFilePath(); try { return await readSettingsFileAt(settingsFilePath); } catch (primaryError) { if (!isFileNotFound(primaryError)) logger.warn(`[SettingsManager] Cannot read settings file ${settingsFilePath}:`, primaryError); try { skipNextBackupRotation = true; return await readSettingsFileAt(getSettingsBackupFilePath()); } catch (backupError) { if (isFileNotFound(primaryError) && isFileNotFound(backupError)) return {}; logger.error(`[SettingsManager] Settings file and backup are unusable: ${settingsFilePath}`, { primaryError, backupError }); throw new Error(`Cannot read settings: ${settingsFilePath} and backup are both unusable.`); } } }
async function writeSettingsFileAtomically(settings: Settings): Promise<void> { const fs = await import("fs/promises"); const settingsFilePath = getSettingsFilePath(); const tempFilePath = getSettingsTempFilePath(); await fs.mkdir(path.dirname(settingsFilePath), { recursive: true }); try { await fs.writeFile(tempFilePath, JSON.stringify(settings, null, 2)); if (!skipNextBackupRotation) { try { await fs.rename(settingsFilePath, getSettingsBackupFilePath()); } catch (error) { if (!isFileNotFound(error)) throw error; } } await fs.rename(tempFilePath, settingsFilePath); skipNextBackupRotation = false; } catch (error) { await fs.rm(tempFilePath, { force: true }).catch(() => {}); throw error; } }
function writeSettingsFile(settings: Settings): Promise<void> { settingsWriteQueue = settingsWriteQueue.catch(() => {}).then(async () => { try { await writeSettingsFileAtomically(settings); } catch (error) { logger.error("[SettingsManager] Error writing settings file:", error); } }); return settingsWriteQueue; }
export function flushSettings(): Promise<void> { return settingsWriteQueue; }

const DEFAULT_TOPIC_DEFAULTS: TopicDefaults = { compactOutputMode: false, showThinkingContent: true, responseStreamingMode: "edit", messageFormatMode: "markdown", showAssistantRunFooter: true, sendDiffFileAttachments: true, promptQueueEnabled: false, variant: undefined };
let currentSettings: Settings = {};
function currentTopicState() { const context = getTopicRuntimeContext(); return context ? getTopicRuntimeStateSync(context.chatId, context.threadId) : null; }
function updateTopic(patch: Parameters<typeof updateTopicRuntimeStateSync>[2]): void { const context = getTopicRuntimeContext(); if (!context) return; updateTopicRuntimeStateSync(context.chatId, context.threadId, patch); }

export function getGlobalSettings(): Settings { return { ...currentSettings }; }
export function getCurrentTopicSettings(): TopicSettings | undefined { return currentTopicState()?.settings; }
export function getTopicDefaults(): TopicDefaults { return { ...DEFAULT_TOPIC_DEFAULTS, ...(currentSettings.topicDefaults ?? {}) }; }
export function setTopicDefaults(defaults: TopicDefaults): void { currentSettings.topicDefaults = { ...DEFAULT_TOPIC_DEFAULTS, ...defaults }; void writeSettingsFile(currentSettings); }
export function updateTopicDefaults(patch: Partial<TopicDefaults>): void { setTopicDefaults({ ...getTopicDefaults(), ...patch }); }
export function getEffectiveTopicSettings(): TopicSettings | undefined { return currentTopicState()?.settings; }
export function updateCurrentTopicSettings(patch: Partial<TopicSettings>): void { updateTopic(patch); }
export function getCurrentProject(): ProjectInfo { const session = getCurrentSession(); const directory = session?.directory ?? process.cwd(); return { id: `session:${session?.id ?? "default"}`, worktree: directory, name: path.basename(directory) || directory }; }
export function setCurrentProject(_projectInfo: ProjectInfo): void { void writeSettingsFile(currentSettings); }
export function clearProject(): void { void writeSettingsFile(currentSettings); }
export function getCurrentSession(): SessionInfo | undefined { return currentTopicState()?.settings.session ?? currentSettings.currentSession; }
export function setCurrentSession(sessionInfo: SessionInfo): void { if (getTopicRuntimeContext()) { updateTopic({ session: sessionInfo }); return; } currentSettings.currentSession = sessionInfo; void writeSettingsFile(currentSettings); }
export function clearSession(): void { if (getTopicRuntimeContext()) { updateTopic({ session: undefined }); return; } currentSettings.currentSession = undefined; void writeSettingsFile(currentSettings); }
export function isPermissionAlwaysAllowed(chatId: number, permission: string): boolean { return currentSettings.alwaysAllowedPermissions?.some((rule) => rule.chatId === chatId && rule.permission === permission) ?? false; }
export function rememberAlwaysAllowedPermission(chatId: number, permission: string): Promise<void> { const current = currentSettings.alwaysAllowedPermissions ?? []; if (current.some((rule) => rule.chatId === chatId && rule.permission === permission)) return Promise.resolve(); currentSettings.alwaysAllowedPermissions = [...current, { chatId, permission, createdAt: new Date().toISOString() }]; return writeSettingsFile(currentSettings); }
export function getCompactOutputMode(): boolean { return currentTopicState()?.settings.compactOutputMode ?? currentSettings.compactOutputMode ?? getTopicDefaults().compactOutputMode; }
export function setCompactOutputMode(enabled: boolean): void { if (getTopicRuntimeContext()) { updateTopic({ compactOutputMode: enabled }); return; } updateTopicDefaults({ compactOutputMode: enabled }); currentSettings.compactOutputMode = enabled; }
export function getShowThinkingContent(): boolean { return currentTopicState()?.settings.showThinkingContent ?? currentSettings.showThinkingContent ?? getTopicDefaults().showThinkingContent; }
export function setShowThinkingContent(enabled: boolean): void { if (getTopicRuntimeContext()) { updateTopic({ showThinkingContent: enabled }); return; } updateTopicDefaults({ showThinkingContent: enabled }); currentSettings.showThinkingContent = enabled; }
export type { MessageFormatMode, ResponseStreamingMode };
export function getResponseStreamingMode(): ResponseStreamingMode { return currentTopicState()?.settings.responseStreamingMode ?? currentSettings.responseStreamingMode ?? getTopicDefaults().responseStreamingMode; }
export function setResponseStreamingMode(mode: ResponseStreamingMode): void { if (getTopicRuntimeContext()) { updateTopic({ responseStreamingMode: mode }); return; } updateTopicDefaults({ responseStreamingMode: mode }); currentSettings.responseStreamingMode = mode; }
export function getMessageFormatMode(): MessageFormatMode { return currentTopicState()?.settings.messageFormatMode ?? currentSettings.messageFormatMode ?? getTopicDefaults().messageFormatMode ?? config.bot.messageFormatMode; }
export function setMessageFormatMode(mode: MessageFormatMode): void { if (getTopicRuntimeContext()) { updateTopic({ messageFormatMode: mode }); return; } updateTopicDefaults({ messageFormatMode: mode }); currentSettings.messageFormatMode = mode; }
export function getShowAssistantRunFooter(): boolean { return currentTopicState()?.settings.showAssistantRunFooter ?? currentSettings.showAssistantRunFooter ?? getTopicDefaults().showAssistantRunFooter; }
export function setShowAssistantRunFooter(enabled: boolean): void { if (getTopicRuntimeContext()) { updateTopic({ showAssistantRunFooter: enabled }); return; } updateTopicDefaults({ showAssistantRunFooter: enabled }); currentSettings.showAssistantRunFooter = enabled; }
export function getSendDiffFileAttachments(): boolean { return currentTopicState()?.settings.sendDiffFileAttachments ?? currentSettings.sendDiffFileAttachments ?? getTopicDefaults().sendDiffFileAttachments; }
export function setSendDiffFileAttachments(enabled: boolean): void { if (getTopicRuntimeContext()) { updateTopic({ sendDiffFileAttachments: enabled }); return; } updateTopicDefaults({ sendDiffFileAttachments: enabled }); currentSettings.sendDiffFileAttachments = enabled; }
export function getPromptQueueEnabled(): boolean { return currentTopicState()?.settings.promptQueueEnabled ?? currentSettings.promptQueueEnabled ?? getTopicDefaults().promptQueueEnabled; }
export function setPromptQueueEnabled(enabled: boolean): void { if (getTopicRuntimeContext()) { updateTopic({ promptQueueEnabled: enabled }); return; } updateTopicDefaults({ promptQueueEnabled: enabled }); currentSettings.promptQueueEnabled = enabled; }
export function getCurrentAgent(): string | undefined { return currentTopicState()?.settings.agent ?? currentSettings.currentAgent; }
export function setCurrentAgent(agentName: string): void { if (getTopicRuntimeContext()) { updateTopic({ agent: agentName }); return; } updateTopicDefaults({ agent: agentName }); currentSettings.currentAgent = agentName; }
export function clearCurrentAgent(): void { if (getTopicRuntimeContext()) { updateTopic({ agent: undefined }); return; } currentSettings.currentAgent = undefined; void writeSettingsFile(currentSettings); }
export function getCurrentModel(): ModelInfo | undefined { return currentTopicState()?.settings.model ?? currentSettings.currentModel; }
export function setCurrentModel(modelInfo: ModelInfo): void { if (getTopicRuntimeContext()) { updateTopic({ model: modelInfo, variant: modelInfo.variant }); return; } updateTopicDefaults({ model: modelInfo, variant: modelInfo.variant }); currentSettings.currentModel = modelInfo; }
export function clearCurrentModel(): void { if (getTopicRuntimeContext()) { updateTopic({ model: undefined }); return; } currentSettings.currentModel = undefined; void writeSettingsFile(currentSettings); }
export function getPinnedMessageId(): number | undefined { return currentSettings.pinnedMessageId; }
export function setPinnedMessageId(messageId: number): void { currentSettings.pinnedMessageId = messageId; void writeSettingsFile(currentSettings); }
export function clearPinnedMessageId(): void { currentSettings.pinnedMessageId = undefined; void writeSettingsFile(currentSettings); }
export function getSessionDirectoryCache(): SessionDirectoryCacheInfo | undefined { return currentSettings.sessionDirectoryCache; }
export function setSessionDirectoryCache(cache: SessionDirectoryCacheInfo): Promise<void> { currentSettings.sessionDirectoryCache = cache; return writeSettingsFile(currentSettings); }
export function clearSessionDirectoryCache(): void { currentSettings.sessionDirectoryCache = undefined; void writeSettingsFile(currentSettings); }
export function getScheduledTasks(): ScheduledTask[] { return cloneScheduledTasks(currentSettings.scheduledTasks) ?? []; }
export function setScheduledTasks(tasks: ScheduledTask[]): Promise<void> { currentSettings.scheduledTasks = cloneScheduledTasks(tasks); return writeSettingsFile(currentSettings); }
export function getScheduledTaskSessionIgnores(): ScheduledTaskSessionIgnoreInfo[] { return cloneScheduledTaskSessionIgnores(currentSettings.scheduledTaskSessionIgnores) ?? []; }
export function setScheduledTaskSessionIgnores(ignores: ScheduledTaskSessionIgnoreInfo[]): Promise<void> { currentSettings.scheduledTaskSessionIgnores = cloneScheduledTaskSessionIgnores(ignores); return writeSettingsFile(currentSettings); }
export function __resetSettingsForTests(): void { currentSettings = {}; settingsWriteQueue = Promise.resolve(); skipNextBackupRotation = false; }
const VALID_STREAMING_MODES: readonly ResponseStreamingMode[] = ["edit", "draft"];
const VALID_MESSAGE_FORMAT_MODES: readonly MessageFormatMode[] = ["raw", "markdown"];
function applyInitialSettingsPreset(preset: Record<string, unknown>): void { const knownKeys = new Set(["compactOutputMode", "showThinkingContent", "showAssistantRunFooter", "responseStreamingMode", "messageFormatMode", "sendDiffFileAttachments", "promptQueueEnabled"]); for (const [key, value] of Object.entries(preset)) { if (!knownKeys.has(key)) throw new Error(`INITIAL_SETTINGS_PRESET: unknown key \"${key}\".`); if (key === "responseStreamingMode") { if (typeof value !== "string" || !VALID_STREAMING_MODES.includes(value as ResponseStreamingMode)) throw new Error(`INITIAL_SETTINGS_PRESET: invalid responseStreamingMode.`); if (currentSettings.responseStreamingMode === undefined) currentSettings.responseStreamingMode = value as ResponseStreamingMode; } else if (key === "messageFormatMode") { if (typeof value !== "string" || !VALID_MESSAGE_FORMAT_MODES.includes(value as MessageFormatMode)) throw new Error(`INITIAL_SETTINGS_PRESET: invalid messageFormatMode.`); if (currentSettings.messageFormatMode === undefined) currentSettings.messageFormatMode = value as MessageFormatMode; } else { if (typeof value !== "boolean") throw new Error(`INITIAL_SETTINGS_PRESET: \"${key}\" must be a boolean.`); if (key === "compactOutputMode" && currentSettings.compactOutputMode === undefined) currentSettings.compactOutputMode = value; if (key === "showThinkingContent" && currentSettings.showThinkingContent === undefined) currentSettings.showThinkingContent = value; if (key === "showAssistantRunFooter" && currentSettings.showAssistantRunFooter === undefined) currentSettings.showAssistantRunFooter = value; if (key === "sendDiffFileAttachments" && currentSettings.sendDiffFileAttachments === undefined) currentSettings.sendDiffFileAttachments = value; if (key === "promptQueueEnabled" && currentSettings.promptQueueEnabled === undefined) currentSettings.promptQueueEnabled = value; } } }
export async function loadSettings(): Promise<void> {
  const loadedSettings = (await readSettingsFile()) as Settings & { serverProcess?: unknown; toolMessagesIntervalSec?: unknown; ttsEnabled?: unknown; ttsMode?: unknown };
  for (const key of ["toolMessagesIntervalSec", "serverProcess", "ttsEnabled", "ttsMode"] as const) delete (loadedSettings as Record<string, unknown>)[key];
  const legacyDefaults = loadedSettings.topicDefaults;
  currentSettings = loadedSettings;
  currentSettings.scheduledTasks = cloneScheduledTasks(loadedSettings.scheduledTasks) ?? [];
  currentSettings.scheduledTaskSessionIgnores = cloneScheduledTaskSessionIgnores(loadedSettings.scheduledTaskSessionIgnores) ?? [];
  currentSettings.alwaysAllowedPermissions = Array.isArray(loadedSettings.alwaysAllowedPermissions) ? loadedSettings.alwaysAllowedPermissions.filter((rule) => rule && typeof rule.chatId === "number" && typeof rule.permission === "string" && typeof rule.createdAt === "string") : [];
  currentSettings.topicDefaults = {
    ...DEFAULT_TOPIC_DEFAULTS,
    ...(legacyDefaults ?? {}),
    ...(legacyDefaults ? {} : {
      model: loadedSettings.currentModel,
      agent: loadedSettings.currentAgent,
      compactOutputMode: loadedSettings.compactOutputMode,
      showThinkingContent: loadedSettings.showThinkingContent,
      responseStreamingMode: loadedSettings.responseStreamingMode,
      messageFormatMode: loadedSettings.messageFormatMode,
      showAssistantRunFooter: loadedSettings.showAssistantRunFooter,
      sendDiffFileAttachments: loadedSettings.sendDiffFileAttachments,
      promptQueueEnabled: loadedSettings.promptQueueEnabled,
    }),
  };
  applyInitialSettingsPreset(config.bot.initialSettingsPreset);
  if (!legacyDefaults) void writeSettingsFile(currentSettings);
}
