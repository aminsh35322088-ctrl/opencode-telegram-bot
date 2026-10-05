import { randomUUID } from "node:crypto";
import { nodeBindings, type NodeBinding } from "./node-bindings.js";
import type { NodeEnvelope } from "./node-protocol.js";
export type { NodeEnvelope } from "./node-protocol.js";
/** Root-owned transport signs/verifies requests without disclosing the per-node key to this client. */
export interface SecureNodeTransport {
  request(binding: Readonly<NodeBinding>, envelope: NodeEnvelope, options?: { signal?: AbortSignal }): Promise<unknown>;
  stream?(binding: Readonly<NodeBinding>, envelope: NodeEnvelope, options?: { signal?: AbortSignal; onReady?: () => void }): AsyncIterable<NodeEnvelope>;
}
let transport: SecureNodeTransport | undefined;
export function installSecureNodeTransport(value: SecureNodeTransport): void {
  if (transport && transport !== value) throw new Error("Node transport already installed");
  transport = value;
}
export class TopicNodeClient {
  constructor(private readonly binding: Readonly<NodeBinding>, private readonly assertCurrent: () => Promise<void>) {}
  private envelope(operation: string, payload: unknown): NodeEnvelope {
    return { version: 1, nodeId: this.binding.nodeId, generation: this.binding.generation, chatId: this.binding.chatId, threadId: this.binding.threadId,
      ...(this.binding.sessionId ? { sessionId: this.binding.sessionId } : {}), operation, payload, timestamp: Date.now(), nonce: randomUUID() };
  }
  async request<T = unknown>(operation: string, payload: unknown = {}, options?: { signal?: AbortSignal }): Promise<T> {
    if (!transport) throw new Error("Secure node transport unavailable");
    if (this.binding.status !== "ready") throw new Error("Topic node is not ready");
    await this.assertCurrent();
    const result = await transport.request(this.binding, this.envelope(operation, payload), options);
    await this.assertCurrent();
    const response = result as { ok?: boolean; result?: T };
    if (!response || response.ok !== true) throw new Error("Topic node request failed");
    return response.result as T;
  }
  async *events(runId: string, after = 0, options?: { signal?: AbortSignal; onReady?: () => void }): AsyncIterable<unknown> {
    if (!transport?.stream) throw new Error("Secure node streaming unavailable");
    await this.assertCurrent();
    for await (const event of transport.stream(this.binding, this.envelope("session.events", { runId, after }), options)) {
      await this.assertCurrent();
      if (event.nodeId !== this.binding.nodeId || event.generation !== this.binding.generation || event.chatId !== this.binding.chatId || event.threadId !== this.binding.threadId || event.sessionId !== this.binding.sessionId || event.operation !== "session.event") throw new Error("Stale or foreign node event");
      const payload = event.payload as { runId?: string; event?: unknown };
      if (payload.runId !== runId) throw new Error("Foreign node run event");
      yield payload.event;
    }
  }
}

export async function resolveTopicNodeClient(chatId: number, threadId: number): Promise<TopicNodeClient | null> {
  const binding = await nodeBindings.find(chatId, threadId);
  if (!binding) return null;
  return new TopicNodeClient(binding, async () => {
    const current = await nodeBindings.find(chatId, threadId);
    if (!current || current.nodeId !== binding.nodeId || current.generation !== binding.generation || current.status !== "ready") throw new Error("Stale topic node binding");
  });
}
/** Fail closed until native response/event adapters preserve the full SDK contract. */
export async function routeBoundSdkOperation(chatId: number, threadId: number, operation: string): Promise<void> {
  if (await nodeBindings.find(chatId, threadId)) throw new Error(`Remote Topic requires native Node RPC adapter: ${operation}`);
}
