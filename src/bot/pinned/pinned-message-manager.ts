import type { Api } from "grammy";
import { logger } from "../../utils/logger.js";
import { opencodeClient } from "../../opencode/client.js";
import { getGitWorktreeContext } from "../../app/services/worktree-service.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import {
  getCurrentProject,
  getPinnedMessageId,
  setPinnedMessageId,
  clearPinnedMessageId,
} from "../../app/stores/settings-store.js";
import {
  DEFAULT_CONTEXT_LIMIT,
  getModelContextLimit,
} from "../../app/services/model-context-limit-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { isExpectedOpencodeUnavailableError } from "../../utils/opencode-error.js";
import type { FileChange, PinnedMessageState, TokensInfo } from "./pinned-message-types.js";
import { t } from "../../i18n/index.js";
import {
  formatContextLine,
  formatCostLine,
  formatModelDisplayName,
} from "./pinned-message-format.js";
import { getSessionStreamThrottleMs } from "../streaming/stream-throttle.js";

class PinnedMessageManager {
  private api: Api | null = null;
  private chatId: number | null = null;
  private state: PinnedMessageState = {
    messageId: null,
    chatId: null,
    sessionId: null,
    sessionTitle: t("pinned.default_session_title"),
    attachActive: false,
    attachBusy: false,
    projectPath: "",
    projectBranch: null,
    projectWorktreePath: null,
    tokensUsed: 0,
    tokensLimit: 0,
    lastUpdated: 0,
    changedFiles: [],
    cost: 0,
  };
  private contextLimit: number | null = null;
  private onKeyboardUpdateCallback?: ((tokensUsed: number, tokensLimit: number) => void) | undefined;
  private updateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private updateTask: Promise<void> | null = null;
  private pendingUpdate = false;
  private pendingForceUpdate = false;
  private lastRenderedMessageText: string | null = null;

  initialize(api: Api, chatId: number): void {
    this.api = api;
    this.chatId = chatId;
    const savedMessageId = getPinnedMessageId();
    if (savedMessageId) {
      this.state.messageId = savedMessageId;
      this.state.chatId = chatId;
    }
  }

  async onSessionChange(sessionId: string, sessionTitle: string): Promise<void> {
    logger.info(`[PinnedManager] Session changed: ${sessionId}, title: ${sessionTitle}`);
    this.state.tokensUsed = 0;
    this.state.cost = 0;
    this.state.sessionId = sessionId;
    this.state.sessionTitle = sessionTitle || t("pinned.default_session_title");
    this.state.attachActive = false;
    this.state.attachBusy = false;
    await this.refreshProjectMetadata();
    await this.fetchContextLimit();
    if (this.onKeyboardUpdateCallback && this.state.tokensLimit > 0) this.onKeyboardUpdateCallback(this.state.tokensUsed, this.state.tokensLimit);
    this.state.changedFiles = [];
    this.lastRenderedMessageText = null;
    this.pendingUpdate = false;
    this.pendingForceUpdate = false;
    await this.unpinOldMessage();
    // Global status messages are intentionally disabled during multi-user testing.
    // Session history, context accounting, and shared workspace remain active.
    await this.loadDiffsFromApi(sessionId);
  }

  async restoreExistingSession(sessionId: string, sessionTitle: string): Promise<void> {
    logger.info(`[PinnedManager] Restoring existing session state: ${sessionId}`);
    this.state.sessionId = sessionId;
    this.state.sessionTitle = sessionTitle || t("pinned.default_session_title");
    this.state.attachActive = false;
    this.state.attachBusy = false;
    this.state.changedFiles = [];
    this.lastRenderedMessageText = null;
    this.pendingUpdate = false;
    this.pendingForceUpdate = false;
    await this.refreshProjectMetadata();
    await this.fetchContextLimit();
    if (this.onKeyboardUpdateCallback && this.state.tokensLimit > 0) this.onKeyboardUpdateCallback(this.state.tokensUsed, this.state.tokensLimit);
    await this.loadDiffsFromApi(sessionId);
  }

  async onSessionTitleUpdate(newTitle: string): Promise<void> {
    if (this.state.sessionTitle !== newTitle && newTitle) this.state.sessionTitle = newTitle;
  }

  async setAttachState(active: boolean, busy: boolean): Promise<void> {
    this.state.attachActive = active;
    this.state.attachBusy = active ? busy : false;
  }

  async loadContextFromHistory(sessionId: string, directory: string): Promise<void> {
    try {
      logger.debug(`[PinnedManager] Loading context from history for session: ${sessionId}`);
      const { data: messagesData, error } = await opencodeClient.session.messages({ sessionID: sessionId, directory });
      if (error || !messagesData) {
        if (isExpectedOpencodeUnavailableError(error)) logger.warn("[PinnedManager] OpenCode server unavailable; skipping session history load");
        else logger.warn("[PinnedManager] Failed to load session history:", error);
        return;
      }
      const lastAssistant = [...messagesData].reverse().find((message) => message.info.role === "assistant");
      const tokens = lastAssistant?.info?.tokens;
      if (tokens) {
        this.state.tokensUsed = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
      }
      const cost = lastAssistant?.info?.cost;
      if (typeof cost === "number") this.state.cost = cost;
      logger.info(`[PinnedManager] Loaded context from history: ${this.state.tokensUsed} tokens, cost: $${this.state.cost.toFixed(2)}`);
    } catch (err) {
      logger.warn("[PinnedManager] Failed to load context from history:", err);
    }
  }

  // The remaining implementation intentionally keeps file-diff/context helpers
  // available for history restoration, but Telegram status-message rendering is
  // disabled in multi-user testing.
  private async refreshProjectMetadata(): Promise<void> {
    const project = getCurrentProject();
    this.state.projectPath = project?.worktree || t("pinned.unknown");
    this.state.projectBranch = null;
    this.state.projectWorktreePath = null;
    if (!project?.worktree) return;
    try {
      const worktreeContext = await getGitWorktreeContext(project.worktree);
      if (!worktreeContext) return;
      this.state.projectPath = worktreeContext.mainProjectPath;
      this.state.projectBranch = worktreeContext.branch;
      this.state.projectWorktreePath = worktreeContext.isLinkedWorktree ? worktreeContext.activeWorktreePath : null;
    } catch (err) {
      logger.debug("[PinnedManager] Could not resolve git worktree metadata:", err);
    }
  }

  private async fetchContextLimit(): Promise<void> {
    try {
      const model = getStoredModel();
      this.contextLimit = await getModelContextLimit(model.providerID, model.modelID);
      this.state.tokensLimit = this.contextLimit;
    } catch (err) {
      if (!isExpectedOpencodeUnavailableError(err)) logger.error("[PinnedManager] Error fetching context limit:", err);
      this.contextLimit = DEFAULT_CONTEXT_LIMIT;
      this.state.tokensLimit = this.contextLimit;
    }
  }

  private async unpinOldMessage(): Promise<void> {
    if (!this.api || !this.chatId || !this.state.messageId) return;
    try {
      await this.api.unpinChatMessage(this.chatId, this.state.messageId);
    } catch (err) {
      logger.debug("[PinnedManager] Could not unpin old status message:", err);
    }
    this.state.messageId = null;
    clearPinnedMessageId();
  }

  private async loadDiffsFromApi(sessionId: string): Promise<void> {
    // Kept as a no-op for now: file persistence belongs to the shared OpenCode
    // workspace, not to Telegram status-message state.
    void sessionId;
  }

  isInitialized(): boolean { return this.api !== null && this.chatId !== null; }
  getState(): PinnedMessageState { return { ...this.state, changedFiles: [...this.state.changedFiles] }; }
  getContextInfo(): TokensInfo { return { tokensUsed: this.state.tokensUsed, tokensLimit: this.state.tokensLimit, cost: this.state.cost }; }
}

export const pinnedMessageManager = new PinnedMessageManager();
