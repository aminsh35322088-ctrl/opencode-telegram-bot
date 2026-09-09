import { getTopicScopeKey } from "./topic-runtime-context.js";

/**
 * A value that is stored per Topic scope instead of in a single module-global.
 *
 * Setup wizards (providers, integrations, MCP add) previously kept their
 * in-progress form state in a module-level `let pending`. Because Telegram
 * Topics run concurrently in one bot process, two Topics that entered the same
 * wizard would overwrite each other's state, so a message typed in one Topic
 * was consumed by the other (or silently dropped). Scoping the pending value by
 * the active Topic key gives every Topic its own independent wizard session.
 */
export class TopicScopedValue<T> {
  private readonly values = new Map<string, T>();

  private read(scope: string | undefined): { key: string; value: T | null } {
    const key = scope ?? getTopicScopeKey();
    return { key, value: this.values.get(key) ?? null };
  }

  get(scope?: string): T | null {
    return this.read(scope).value;
  }

  set(value: T, scope?: string): void {
    this.values.set(scope ?? getTopicScopeKey(), value);
  }

  clear(scope?: string): void {
    this.values.delete(scope ?? getTopicScopeKey());
  }

  isActive(scope?: string): boolean {
    return this.read(scope).value !== null;
  }

  clearAll(): void {
    this.values.clear();
  }
}
