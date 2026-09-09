import type { Api } from "grammy";
import { logger } from "../../utils/logger.js";
import { opencodeClient } from "../../opencode/client.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { getModelContextLimit, DEFAULT_CONTEXT_LIMIT } from "../../app/services/model-context-limit-service.js";
import { isExpectedOpencodeUnavailableError } from "../../utils/opencode-error.js";
import { getCurrentSession } from "../../app/services/session-service.js";
import { getTopicRuntimeContext } from "../../app/services/topic-runtime-context.js";
import type { FileChange, PinnedMessageState, TokensInfo } from "./pinned-message-types.js";
import { t } from "../../i18n/index.js";

type ContextInfo = { tokensUsed: number; tokensLimit: number };

interface PinnedScope {
  contextLimit: number;
  state: PinnedMessageState;
}

const createScope = (chatId: number | null): PinnedScope => ({
  contextLimit: DEFAULT_CONTEXT_LIMIT,
  state: {
    messageId: null,
    chatId,
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
  },
});

/**
 * Telegram status/pinned-message rendering is disabled during multi-developer
 * testing. OpenCode history, context accounting and the shared workspace remain
 * global; this manager only keeps the API expected by the rest of the bot.
 *
 * Context accounting is scoped per session: concurrently streaming Topics each
 * track their own tokens/cost/changed files (keyed by the session of the active
 * runtime context), so a run in one Topic can no longer rewrite another
 * Topic's context usage or model context limit.
 */
class PinnedMessageManager {
  private api: Api | null = null;
  private chatId: number | null = null;
  private onKeyboardUpdateCallback?: ((tokensUsed: number, tokensLimit: number) => void) | undefined;
  private readonly scopes = new Map<string, PinnedScope>();
  private focusKey: string | null = null;

  private scopeKey(sessionId?: string | null): string {
    if (sessionId) {
      this.focusKey = sessionId;
      return sessionId;
    }
    const topic = getTopicRuntimeContext();
    if (topic?.sessionId) return topic.sessionId;
    return getCurrentSession()?.id ?? this.focusKey ?? "__main__";
  }

  private scope(sessionId?: string | null): PinnedScope {
    const key = this.scopeKey(sessionId);
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = createScope(this.chatId);
      this.scopes.set(key, scope);
    }
    return scope;
  }

  initialize(api: Api, chatId: number): void {
    this.api = api;
    this.chatId = chatId;
    this.scope().state.chatId = chatId;
  }

  async onSessionChange(sessionId: string, sessionTitle: string): Promise<void> {
    const scope = this.scope(sessionId);
    scope.state.sessionId = sessionId;
    scope.state.sessionTitle = sessionTitle || t("pinned.default_session_title");
    scope.state.tokensUsed = 0;
    scope.state.cost = 0;
    scope.state.changedFiles = [];
    await this.refreshContextLimit(sessionId);
  }

  async restoreExistingSession(sessionId: string, sessionTitle: string): Promise<void> {
    const scope = this.scope(sessionId);
    scope.state.sessionId = sessionId;
    scope.state.sessionTitle = sessionTitle || t("pinned.default_session_title");
    await this.refreshContextLimit(sessionId);
  }

  async onSessionTitleUpdate(newTitle: string): Promise<void> {
    if (newTitle) this.scope().state.sessionTitle = newTitle;
  }

  async setAttachState(active: boolean, busy: boolean): Promise<void> {
    const scope = this.scope();
    scope.state.attachActive = active;
    scope.state.attachBusy = active ? busy : false;
  }

  async loadContextFromHistory(sessionId: string, directory: string): Promise<void> {
    const scope = this.scope(sessionId);
    try {
      const { data, error } = await opencodeClient.session.messages({ sessionID: sessionId, directory });
      if (error || !data) { if (!isExpectedOpencodeUnavailableError(error)) logger.debug("[PinnedManager] Failed to load session history", error); return; }
      const lastAssistant = [...data].reverse().find((message) => message.info.role === "assistant");
      const info = lastAssistant?.info as unknown as { tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }; cost?: number } | undefined;
      const tokens = info?.tokens;
      // `input + cache.read` is the closest provider-independent representation
      // of the context consumed by the latest generation. Output/reasoning and
      // cache writes are usage/billing metadata, not input context occupancy.
      if (tokens) scope.state.tokensUsed = tokens.input + tokens.cache.read;
      if (typeof info?.cost === "number") scope.state.cost = info.cost;
      scope.state.sessionId = sessionId;
      this.notifyKeyboard(sessionId);
    } catch (error) { if (!isExpectedOpencodeUnavailableError(error)) logger.debug("[PinnedManager] Failed to load context history", error); }
  }

  async onSessionCompacted(sessionId: string, directory: string): Promise<void> { await this.loadContextFromHistory(sessionId, directory); }
  async onMessageComplete(tokens: TokensInfo): Promise<void> { this.scope().state.tokensUsed = tokens.input + tokens.cacheRead; this.notifyKeyboard(); }
  updateTokensSilent(tokens: TokensInfo): void { this.scope().state.tokensUsed = tokens.input + tokens.cacheRead; }
  async refresh(): Promise<void> { await this.refreshContextLimit(); }
  async onCostUpdate(cost: number): Promise<void> { if (Number.isFinite(cost)) this.scope().state.cost = (this.scope().state.cost || 0) + cost; }
  setOnKeyboardUpdate(callback: (tokensUsed: number, tokensLimit: number) => void): void { this.onKeyboardUpdateCallback = callback; this.notifyKeyboard(); }
  getContextInfo(): ContextInfo { const scope = this.scope(); return { tokensUsed: scope.state.tokensUsed, tokensLimit: scope.state.tokensLimit }; }
  getContextLimit(): number { return this.scope().contextLimit; }

  async refreshContextLimit(sessionId?: string | null): Promise<void> {
    const scope = this.scope(sessionId);
    try {
      const model = getStoredModel();
      scope.contextLimit = await getModelContextLimit(model.providerID, model.modelID);
      scope.state.tokensLimit = scope.contextLimit;
    } catch (error) {
      if (!isExpectedOpencodeUnavailableError(error)) logger.debug("[PinnedManager] Failed to refresh context limit", error);
      scope.contextLimit = DEFAULT_CONTEXT_LIMIT;
      scope.state.tokensLimit = DEFAULT_CONTEXT_LIMIT;
    }
    this.notifyKeyboard(sessionId);
  }

  async onSessionDiff(diffs: FileChange[]): Promise<void> { this.scope().state.changedFiles = [...diffs]; }

  addFileChange(change: FileChange): void {
    const scope = this.scope();
    const existing = scope.state.changedFiles.find((file) => file.file === change.file);
    if (existing) { existing.additions += change.additions; existing.deletions += change.deletions; }
    else scope.state.changedFiles.push({ ...change });
  }

  getState(): PinnedMessageState { const state = this.scope().state; return { ...state, changedFiles: [...state.changedFiles] }; }
  isInitialized(): boolean { return this.api !== null && this.chatId !== null; }

  async clear(): Promise<void> {
    const key = this.scopeKey();
    this.scopes.set(key, createScope(this.chatId));
    if (this.focusKey === key) this.focusKey = null;
  }

  __resetForTests(): void {
    this.api = null; this.chatId = null; this.onKeyboardUpdateCallback = undefined;
    this.scopes.clear();
    this.focusKey = null;
  }

  private notifyKeyboard(sessionId?: string | null): void {
    const scope = this.scope(sessionId);
    if (this.onKeyboardUpdateCallback && scope.state.tokensLimit > 0) this.onKeyboardUpdateCallback(scope.state.tokensUsed, scope.state.tokensLimit);
  }
}

export const pinnedMessageManager = new PinnedMessageManager();
