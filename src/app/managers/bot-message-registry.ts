export interface BotMessageEntry {
  chatId: number;
  messageId: number;
  sessionId: string;
  registeredAt: number;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

const entries = new Map<string, BotMessageEntry>();

function key(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [mapKey, entry] of entries) {
    if (entry.registeredAt < cutoff) entries.delete(mapKey);
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function registerBotMessage(input: { chatId: number; messageId: number; sessionId: string }): void {
  if (!Number.isFinite(input.chatId) || !Number.isFinite(input.messageId) || !input.sessionId) return;
  const mapKey = key(input.chatId, input.messageId);
  entries.delete(mapKey);
  entries.set(mapKey, { ...input, registeredAt: Date.now() });
  prune();
}

export function lookupBotMessage(chatId: number, messageId: number): BotMessageEntry | null {
  const entry = entries.get(key(chatId, messageId));
  if (!entry) return null;
  if (Date.now() - entry.registeredAt > TTL_MS) {
    entries.delete(key(chatId, messageId));
    return null;
  }
  return entry;
}

export function __resetBotMessageRegistryForTests(): void {
  entries.clear();
}
