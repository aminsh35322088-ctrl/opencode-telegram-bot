import { promptQueue, type QueuedPrompt } from "../../app/managers/prompt-queue-manager.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { t } from "../../i18n/index.js";

const QUEUED_PROMPT_PREVIEW_MAX_LENGTH = 28;
function buildPreview(text: string): string { const collapsed = text.replace(/\s+/g, " ").trim(); return collapsed.length <= QUEUED_PROMPT_PREVIEW_MAX_LENGTH ? collapsed : `${collapsed.slice(0, QUEUED_PROMPT_PREVIEW_MAX_LENGTH - 1)}…`; }
export function formatQueuedPromptButtonLabel(index: number, text: string): string { return t("keyboard.queued_prompt", { index: String(index), text: buildPreview(text) }); }
export function getQueuedPromptButtonLabels(sessionId?: string): string[] { return promptQueue.list(sessionId ?? getCurrentSession()?.id).map((item, index) => formatQueuedPromptButtonLabel(index + 1, item.text)); }
export function findQueuedPromptByButtonLabel(label: string, sessionId?: string): QueuedPrompt | null { const items = promptQueue.list(sessionId ?? getCurrentSession()?.id); const index = items.findIndex((item, itemIndex) => formatQueuedPromptButtonLabel(itemIndex + 1, item.text) === label); return index < 0 ? null : (items[index] ?? null); }
