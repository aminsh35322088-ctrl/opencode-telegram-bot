import {
  getCurrentSession as getSettingsSession,
  setCurrentSession as setSettingsSession,
  clearSession as clearSettingsSession,
} from "../stores/settings-store.js";
import { promptQueue } from "../managers/prompt-queue-manager.js";
import { promptAttachment } from "../managers/prompt-attachment-manager.js";
import type { SessionInfo } from "../types/session.js";
import { getTopicRuntimeContext } from "./topic-runtime-context.js";
import { findTelegramTopicBindingByThread } from "./telegram-topic-store.js";
import { resolveCoreTopicBinding } from "../../core/native-core-service.js";
import path from "node:path";

export type { SessionInfo };

export function setCurrentSession(sessionInfo: SessionInfo): void {
  if (getSettingsSession()?.id !== sessionInfo.id) {
    promptQueue.clear("session_switched");
    promptAttachment.clear("session_switched");
  }
  setSettingsSession(sessionInfo);
}

export function getCurrentSession(): SessionInfo | null {
  const topic = getTopicRuntimeContext();
  if (topic && (!topic.sessionId || !topic.directory)) return null;
  if (topic?.sessionId && topic.directory) {
    return {
      id: topic.sessionId,
      title: "Telegram Topic",
      directory: topic.directory,
    };
  }

  return getSettingsSession() ?? null;
}

/** Resolve the session for the current request without letting a Topic fall back to the global foreground session. */
export async function getEffectiveCurrentSession(): Promise<SessionInfo | null> {
  const topic = getTopicRuntimeContext();
  if (topic && !topic.sessionId) return null;
  if (topic?.sessionId) {
    const core = resolveCoreTopicBinding(topic.chatId, topic.threadId);
    if (core?.sessionId !== topic.sessionId || core.normalizedDirectory !== path.resolve(topic.directory ?? "")) return null;
    const binding = await findTelegramTopicBindingByThread(topic.chatId, topic.threadId);
    if (binding?.sessionId === topic.sessionId && binding.directory === topic.directory) {
      return {
        id: binding.sessionId,
        title: binding.title ?? "Telegram Topic",
        directory: binding.directory,
      };
    }
    return null;
  }
  return getCurrentSession();
}

export function getCurrentSessionDirectory(): string {
  return getCurrentSession()?.directory ?? process.cwd();
}

export function clearSession(): void {
  promptQueue.clear("session_cleared");
  promptAttachment.clear("session_cleared");
  clearSettingsSession();
}
