import type { Api } from "grammy";
import { logger } from "../../utils/logger.js";
import { opencodeClient } from "../../opencode/client.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { getModelContextLimit, DEFAULT_CONTEXT_LIMIT } from "../../app/services/model-context-limit-service.js";
import { isExpectedOpencodeUnavailableError } from "../../utils/opencode-error.js";
import type { FileChange, PinnedMessageState, TokensInfo } from "./pinned-message-types.js";
import { t } from "../../i18n/index.js";

/**
 * The status/pinned-message UI is intentionally disabled for the current
 * multi-developer testing phase. The OpenCode session, history and shared
 * workspace remain global; only Telegram chat presentation is private.
 *
 * Keeping this manager API-compatible avoids changing the rest of the bot while
 * preventing a singleton status message from leaking one user's state into
 * another user's chat.
 */
class PinnedMessageManager {
  private api: Api | null = null;
  private chatId: number | null = null;
  private contextLimit = DEFAULT_CONTEXT_LIMIT;
  private onKeyboardUpdateCallback?: ((tokensUsed: number, tokensLimit: number) => void) | undefined;
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
    tokensLimit: DEFAULT_CONTEXT_LIMIT,
    lastUpdated: 0,
    changedFiles: [],
    cost: 0,
  };

  initialize(api: Api, chatId: number): void {
    this.api = api;
    this.chatId = chatId;
    this.state.chatId = chatId;
  }

  async onSessionChange(sessionId: string, sessionTitle: string): Promise<void> {
    this.state.sessionId = sessionId;
    this.state.sessionTitle = sessionTitle || t("pinned.default_session_title");
    this.state.tokensUsed = 0;
    this.state.cost = 0;
    this.state.changedFiles = [];
    await this.refreshContextLimit();
  }

  async restoreExistingSession(sessionId: string, sessionTitle: string): Promise<void> {
    this.state.sessionId = sessionId;
    this.state.sessionTitle = sessionTitle || t("pinned.default_session_title");
    await this.refreshContextLimit();
  }

  async onSessionTitleUpdate(newTitle: string): Promise<void> {
    if (newTitle) this.state.sessionTitle = newTitle;
  }

  async setAttachState(active: boolean, busy: boolean): Promise<void> {
    this.state.attachActive = active;
    this.state.attachBusy = active ? busy : false;
  }

  async loadContextFromHistory(sessionId: string, directory: string): Promise<void> {
    try {
      const { data, error } = await opencodeClient.session.messages({ sessionID: sessionId, directory });
      if (error || !data) {
        if (!isExpectedOpencodeUnavailableError(error)) logger.debug("[PinnedManager] Failed to load session history", error);
        return;
      }
      const lastAssistant = [...data].reverse().find((message) => message.info.role === "assistant");
      const tokens = lastAssistant?.info?.tokens;
      if (tokens) this.state.tokensUsed = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
      const cost = lastAssistant?.info?.cost;
      if (typeof cost === "number") this.state.cost = cost;
      this.state.sessionId = sessionId;
      this.notifyKeyboard();
    } catch (error) {
      if (!isExpectedOpencodeUnavailableError(error)) logger.debug("[PinnedManager] Failed to load context history", error);
    }
  }

  async onSessionCompacted(sessionId: string, directory: string): Promise<void> {
    await this.loadContextFromHistory(sessionId, directory);
  }

  async onMessageComplete(tokens: TokensInfo): Promise<void> {
    this.state.tokensUsed = tokens.input + tokens.cacheRead;
    this.notifyKeyboard();
  }

  updateTokensSilent(tokens: TokensInfo): void {
    this.state.tokensUsed = tokens.input + tokens.cacheRead;
  }

  async refresh(): Promise<void> {
    await this.refreshContextLimit();
  }

  async onCostUpdate(cost: number): Promise<void> {
    if (Number.isFinite(cost)) this.state.cost = (this.state.cost || 0) + cost;
  }

  setOnKeyboardUpdate(callback: (tokensUsed: number, tokensLimit: number) => void): void {
    this.onKeyboardUpdateCallback = callback;
    this.notifyKeyboard();
  }

  getContextInfo(): TokensInfo {
    return {
      tokensUsed: this.state.tokensUsed,
      tokensLimit: this.state.tokensLimit,
      cost: this.state.cost,
    };
  }

  getContextLimit(): number {
    return this.contextLimit;
  }

  async refreshContextLimit(): Promise<void> {
    try {
      const model = getStoredModel();
      this.contextLimit = await getModelContextLimit(model.providerID, model.modelID);
      this.state.tokensLimit = this.contextLimit;
    } catch (error) {
      if (!isExpectedOpencodeUnavailableError(error)) logger.debug("[PinnedManager] Failed to refresh context limit", error);
      this.contextLimit = DEFAULT_CONTEXT_LIMIT;
      this.state.tokensLimit = DEFAULT_CONTEXT_LIMIT;
    }
    this.notifyKeyboard();
  }

  async onSessionDiff(diffs: FileChange[]): Promise<void> {
    this.state.changedFiles = [...diffs];
  }

  addFileChange(change: FileChange): void {
    const existing = this.state.changedFiles.find((file) => file.file === change.file);
    if (existing) {
      existing.additions += change.additions;
      existing.deletions += change.deletions;
    } else {
      this.state.changedFiles.push({ ...change });
    }
  }

  getState(): PinnedMessageState {
    return { ...this.state, changedFiles: [...this.state.changedFiles] };
  }

  isInitialized(): boolean {
    return this.api !== null && this.chatId !== null;
  }

  async clear(): Promise<void> {
    this.state.messageId = null;
    this.state.sessionId = null;
    this.state.sessionTitle = t("pinned.default_session_title");
    this.state.attachActive = false;
    this.state.attachBusy = false;
    this.state.tokensUsed = 0;
    this.state.changedFiles = [];
    this.state.cost = 0;
  }

  __resetForTests(): void {
    this.api = null;
    this.chatId = null;
    this.contextLimit = DEFAULT_CONTEXT_LIMIT;
    this.onKeyboardUpdateCallback = undefined;
    this.state = {
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
      tokensLimit: DEFAULT_CONTEXT_LIMIT,
      lastUpdated: 0,
      changedFiles: [],
      cost: 0,
    };
  }

  private notifyKeyboard(): void {
    if (this.onKeyboardUpdateCallback && this.state.tokensLimit > 0) {
      this.onKeyboardUpdateCallback(this.state.tokensUsed, this.state.tokensLimit);
    }
  }
}

export const pinnedMessageManager = new PinnedMessageManager();
