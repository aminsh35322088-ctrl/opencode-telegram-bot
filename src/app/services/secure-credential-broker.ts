import { randomUUID } from "node:crypto";
import { getStoredExtension } from "./extension-store.js";
import { getExtensionCredentialStatus, saveExtensionCredential } from "./credential-vault-service.js";
import type { ExtensionCredentialSchema } from "../types/extension.js";

const CHALLENGE_TTL_MS = 10 * 60_000;

export interface SecureCredentialChallenge {
  id: string;
  extensionId: string;
  credentialId: string;
  sessionId: string;
  projectDirectory: string;
  chatId?: number;
  threadId?: number;
  requestedAt: number;
  expiresAt: number;
  used: boolean;
}

const challenges = new Map<string, SecureCredentialChallenge>();

function prune(): void {
  const now = Date.now();
  for (const [id, challenge] of challenges) if (challenge.used || challenge.expiresAt <= now) challenges.delete(id);
}

async function schemaFor(extensionId: string, credentialId: string): Promise<ExtensionCredentialSchema> {
  const extension = await getStoredExtension(extensionId);
  if (!extension) throw new Error("Credential request denied: extension is not registered.");
  const schema = extension.credentialSchemas.find((candidate) => candidate.id === credentialId);
  if (!schema) throw new Error("Credential request denied: credential schema is not registered for this extension.");
  return schema;
}

export async function createSecureCredentialChallenge(input: {
  extensionId: string;
  credentialId: string;
  sessionId: string;
  projectDirectory: string;
}): Promise<{ challengeId: string; status: "awaiting-user-input"; credential: { configured: boolean; label: string; type: string } }> {
  prune();
  const schema = await schemaFor(input.extensionId, input.credentialId);
  const now = Date.now();
  const challenge: SecureCredentialChallenge = {
    id: randomUUID(),
    extensionId: input.extensionId,
    credentialId: input.credentialId,
    sessionId: input.sessionId,
    projectDirectory: input.projectDirectory,
    requestedAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
    used: false,
  };
  challenges.set(challenge.id, challenge);
  return {
    challengeId: challenge.id,
    status: "awaiting-user-input",
    credential: {
      configured: (await getExtensionCredentialStatus(input.extensionId, input.credentialId)) === "configured",
      label: schema.label,
      type: schema.type,
    },
  };
}

export function bindSecureCredentialChallenge(challengeId: string, chatId: number, threadId?: number): SecureCredentialChallenge {
  prune();
  const challenge = challenges.get(challengeId);
  if (!challenge || challenge.used || challenge.expiresAt <= Date.now()) throw new Error("Secure credential challenge expired.");
  if (challenge.chatId !== undefined && challenge.chatId !== chatId) throw new Error("Secure credential challenge scope mismatch.");
  if (challenge.threadId !== undefined && challenge.threadId !== threadId) throw new Error("Secure credential challenge Topic mismatch.");
  challenge.chatId = chatId;
  if (threadId !== undefined) challenge.threadId = threadId;
  return { ...challenge };
}

export function getSecureCredentialChallenge(challengeId: string): SecureCredentialChallenge | null {
  prune();
  const challenge = challenges.get(challengeId);
  return challenge ? { ...challenge } : null;
}

export function findSecureCredentialChallenge(chatId: number, threadId?: number): SecureCredentialChallenge | null {
  prune();
  const matches = [...challenges.values()].filter((item) => !item.used && item.chatId === chatId && item.threadId === threadId);
  if (matches.length !== 1) return null;
  return { ...matches[0]! };
}

export async function submitSecureCredential(challengeId: string, chatId: number, threadId: number | undefined, secret: string): Promise<SecureCredentialChallenge> {
  prune();
  const challenge = challenges.get(challengeId);
  if (!challenge || challenge.used || challenge.expiresAt <= Date.now()) throw new Error("Secure credential challenge expired.");
  if (challenge.chatId !== chatId || challenge.threadId !== threadId) throw new Error("Secure credential challenge scope mismatch.");
  await schemaFor(challenge.extensionId, challenge.credentialId);
  await saveExtensionCredential(challenge.extensionId, challenge.credentialId, secret);
  challenge.used = true;
  challenges.delete(challengeId);
  return { ...challenge };
}

export function cancelSecureCredentialChallenge(challengeId: string): boolean {
  const challenge = challenges.get(challengeId);
  if (!challenge) return false;
  challenge.used = true;
  challenges.delete(challengeId);
  return true;
}
