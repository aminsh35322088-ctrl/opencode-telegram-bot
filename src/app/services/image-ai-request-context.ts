import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<number>();

export function getImageAiRequestChatId(): number | undefined {
  const value = storage.getStore();
  return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
}

export function runWithImageAiChatId<T>(chatId: number, callback: () => T): T {
  return storage.run(chatId, callback);
}
