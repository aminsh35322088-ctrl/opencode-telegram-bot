[Reading 111 lines from start (total: 111 lines, 0 remaining)]

export type RustDeskSecureInputStateValue = "required" | "resolved";

export interface RustDeskSecureInputSignal {
  state: RustDeskSecureInputStateValue;
  credentialRequestId: string;
  connectionId?: string;
  credentialKind?: string;
}

export interface RustDeskSecureInputChallenge {
  sessionId: string;
  callId: string;
  chatId: number;
  credentialRequestId: string;
  connectionId: string;
  credentialKind?: string;
  promptMessageId?: number;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseRustDeskSecureInputSignal(
  metadata: Record<string, unknown> | undefined,
): RustDeskSecureInputSignal | null {
  const value = metadata?.rustdeskSecureInput;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const state = clean(record.state);
  const credentialRequestId = clean(record.credentialRequestId);
  if ((state !== "required" && state !== "resolved") || !credentialRequestId) return null;
  return {
    state,
    credentialRequestId,
    connectionId: clean(record.connectionId),
    credentialKind: clean(record.credentialKind),
  };
}

class RustDeskSecureInputManager {
  private readonly challenges = new Map<string, RustDeskSecureInputChallenge>();

  start(
    input: Omit<RustDeskSecureInputChallenge, "createdAt" | "expiresAt" | "promptMessageId">,
    ttlMs = DEFAULT_TTL_MS,
  ): { created: boolean; challenge: RustDeskSecureInputChallenge } {
    const current = this.get(input.sessionId);
    if (
      current &&
      current.credentialRequestId === input.credentialRequestId &&
      current.connectionId === input.connectionId
    ) {
      return { created: false, challenge: current };
    }

    const now = Date.now();
    const challenge: RustDeskSecureInputChallenge = {
      ...input,
      createdAt: now,
      expiresAt: now + Math.max(1_000, ttlMs),
    };
    this.challenges.set(input.sessionId, challenge);
    return { created: true, challenge: { ...challenge } };
  }

  get(sessionId: string, now = Date.now()): RustDeskSecureInputChallenge | null {
    const challenge = this.challenges.get(sessionId);
    if (!challenge) return null;
    if (now >= challenge.expiresAt) {
      this.challenges.delete(sessionId);
      return null;
    }
    return { ...challenge };
  }

  isActive(sessionId: string): boolean {
    return this.get(sessionId) !== null;
  }

  setPromptMessageId(
    sessionId: string,
    credentialRequestId: string,
    promptMessageId: number,
  ): void {
    const challenge = this.challenges.get(sessionId);
    if (!challenge || challenge.credentialRequestId !== credentialRequestId) return;
    challenge.promptMessageId = promptMessageId;
  }

  clear(sessionId: string, credentialRequestId?: string): boolean {
    const challenge = this.challenges.get(sessionId);
    if (!challenge) return false;
    if (credentialRequestId && challenge.credentialRequestId !== credentialRequestId) return false;
    return this.challenges.delete(sessionId);
  }

  clearAll(): void {
    this.challenges.clear();
  }

  __resetForTests(): void {
    this.clearAll();
  }
}

export const rustDeskSecureInputManager = new RustDeskSecureInputManager();

[executed on device: runnervmlun5p (3784ff4d-04bd-49e4-95bf-176085794429)]