export interface CoreTopicBindingInput {
  chatId: number;
  threadId: number;
  sessionId: string;
  directory: string;
}

export interface CoreBindingOwner {
  bindingId: string;
  botId: string;
  chatId: number;
  threadId: number;
  sessionId: string;
  directory: string;
  bindingGeneration: number;
}

export interface CoreAbortTarget {
  sessionId: string;
  directory: string;
}

export interface CoreOwnedTaskContext {
  signal: AbortSignal;
  setAbortTarget(target: CoreAbortTarget | null): void;
}
