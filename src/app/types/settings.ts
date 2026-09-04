import type { ModelInfo } from "./model.js";
import type { ProjectInfo } from "./project.js";
import type { SessionDirectoryCacheInfo, SessionInfo } from "./session.js";
import type { ScheduledTask } from "./scheduled-task.js";
import type { TopicDefaults } from "./topic-settings.js";

export type ResponseStreamingMode = "edit" | "draft";
export type MessageFormatMode = "raw" | "markdown";

export interface ScheduledTaskSessionIgnoreInfo {
  sessionId: string;
  createdAt: string;
}

export interface AlwaysAllowedPermissionInfo {
  chatId: number;
  permission: string;
  createdAt: string;
}

/**
 * Account/application-level configuration. Topic-local behavior is deliberately
 * excluded from this interface; a Topic owns its own TopicSettings.
 */
export interface GlobalSettings {
  pinnedMessageId?: number;
  sessionDirectoryCache?: SessionDirectoryCacheInfo;
  scheduledTasks?: ScheduledTask[];
  scheduledTaskSessionIgnores?: ScheduledTaskSessionIgnoreInfo[];
  alwaysAllowedPermissions?: AlwaysAllowedPermissionInfo[];
  topicDefaults?: TopicDefaults;
}

/**
 * Legacy persisted shape kept during migration. New code should use
 * GlobalSettings plus TopicSettings rather than treating this as a single
 * mutable settings bag.
 */
export interface Settings extends GlobalSettings {
  currentProject?: ProjectInfo;
  currentSession?: SessionInfo;
  currentAgent?: string;
  currentModel?: ModelInfo;
  compactOutputMode?: boolean;
  showThinkingContent?: boolean;
  showAssistantRunFooter?: boolean;
  responseStreamingMode?: ResponseStreamingMode;
  messageFormatMode?: MessageFormatMode;
  sendDiffFileAttachments?: boolean;
  promptQueueEnabled?: boolean;
}
