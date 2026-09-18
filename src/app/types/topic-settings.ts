import type { ModelInfo } from "./model.js";
import type { SessionInfo } from "./session.js";
import type { MessageFormatMode, ResponseStreamingMode } from "./settings.js";
import type { ImageModelSelection } from "./image-model.js";

export type TopicRunState = "idle" | "running" | "paused" | "aborting";

/**
 * Settings and execution state that belong exclusively to one Telegram Topic.
 * These values must never be read from global Settings while a Topic context
 * is active.
 */
export interface TopicSettings {
  session?: SessionInfo;
  model?: ModelInfo;
  /** Optional per-Topic override. Undefined means inherit the global Default Image Model dynamically. */
  imageModelOverride?: ImageModelSelection;
  agent?: string;
  variant?: string;
  compactOutputMode: boolean;
  showThinkingContent: boolean;
  responseStreamingMode: ResponseStreamingMode;
  messageFormatMode: MessageFormatMode;
  showAssistantRunFooter: boolean;
  sendDiffFileAttachments: boolean;
  promptQueueEnabled: boolean;
  runState: TopicRunState;
  workspaceDirectory?: string;
  updatedAt: string;
}

/**
 * Values used only when a new Topic is created. A Topic receives a snapshot of
 * these defaults; later default changes must not mutate existing Topics.
 */
export type TopicDefaults = Omit<
  TopicSettings,
  "session" | "imageModelOverride" | "runState" | "workspaceDirectory" | "updatedAt"
>;
