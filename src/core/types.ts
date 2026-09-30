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

export type { OpenCodeAbortTarget as CoreAbortTarget, OpenCodeTaskContext as CoreOwnedTaskContext } from "@opencode-telegram/native-runtime";
