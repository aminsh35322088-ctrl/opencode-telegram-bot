import { randomUUID } from "node:crypto";
import { getStoredExtension } from "./extension-store.js";
import { getExtensionCredentialStatus, saveExtensionCredential } from "./credential-vault-service.js";
import type { ExtensionCredentialSchema } from "../types/extension.js";
import {
  listSharedCredentialChallenges,
  readSharedCredentialChallenge,
  removeSharedCredentialChallenge,
  writeSharedCredentialChallenge,
} from "./extension-automation-state-store.js";

const CHALLENGE_TTL_MS = 10 * 60_000;

export interface SecureCredentialChallenge {
  id: string;
  extensionId: string;
  credentialId: string;
  sessionId: string;
  projectDirectory: string;
  chatId?: number;
  threadId?: number;
  userId?: number;
  requestedAt: number;
  expiresAt: number;
  used: boolean;
}

function prune(): void {
  const now = Date.now();
  for (const challenge of listSharedCredentialChallenges<SecureCredentialChallenge>()) {
    if (challenge.used || challenge.expiresAt <= now) {
      removeSharedCredentialChallenge(challenge.id);
    }
  }
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
  writeSharedCredentialChallenge(challenge);
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

export function bindSecureCredentialChallenge(
  challengeId: string,
  chatId: number,
  threadId: number | undefined,
  userId: number,
): SecureCredentialChallenge {
  prune();
  const challenge = readSharedCredentialChallenge<SecureCredentialChallenge>(challengeId);
  if (!challenge || challenge.used || challenge.expiresAt <= Date.now()) throw new Error("Secure credential challenge expired.");
  if (challenge.chatId !== undefined && challenge.chatId !== chatId) throw new Error("Secure credential challenge scope mismatch.");
  if (challenge.threadId !== undefined && challenge.threadId !== threadId) throw new Error("Secure credential challenge Topic mismatch.");
  if (challenge.userId !== undefined && challenge.userId !== userId) throw new Error("Secure credential challenge user mismatch.");
  challenge.chatId = chatId;
  challenge.userId = userId;
  if (threadId !== undefined) challenge.threadId = threadId;
  writeSharedCredentialChallenge(challenge);
  return { ...challenge };
}

export function getSecureCredentialChallenge(challengeId: string): SecureCredentialChallenge | null {
  prune();
  const challenge = readSharedCredentialChallenge<SecureCredentialChallenge>(challengeId);
  return challenge ? { ...challenge } : null;
}

export function findSecureCredentialChallenge(chatId: number, threadId?: number): SecureCredentialChallenge | null {
  prune();
  const matches = listSharedCredentialChallenges<SecureCredentialChallenge>()
    .filter((item) => !item.used && item.chatId === chatId && item.threadId === threadId);
  return matches.length === 1 ? { ...matches[0]! } : null;
}

export function findUnboundSecureCredentialChallenge(sessionId: string): SecureCredentialChallenge | null {
  prune();
  const matches = listSharedCredentialChallenges<SecureCredentialChallenge>()
    .filter((item) => !item.used && item.sessionId === sessionId && item.chatId === undefined);
  return matches.length === 1 ? { ...matches[0]! } : null;
}

export async function submitSecureCredential(
  challengeId: string,
  chatId: number,
  threadId: number | undefined,
  userId: number,
  secret: string,
): Promise<SecureCredentialChallenge> {
  prune();
  const challenge = readSharedCredentialChallenge<SecureCredentialChallenge>(challengeId);
  if (!challenge || challenge.used || challenge.expiresAt <= Date.now()) throw new Error("Secure credential challenge expired.");
  if (challenge.chatId !== chatId || challenge.threadId !== threadId || challenge.userId !== userId) {
    throw new Error("Secure credential challenge scope mismatch.");
  }
  await schemaFor(challenge.extensionId, challenge.credentialId);
  await saveExtensionCredential(challenge.extensionId, challenge.credentialId, secret);
  challenge.used = true;
  removeSharedCredentialChallenge(challengeId);
  return { ...challenge };
}

export function cancelSecureCredentialChallenge(challengeId: string): boolean {
  const challenge = readSharedCredentialChallenge<SecureCredentialChallenge>(challengeId);
  if (!challenge) return false;
  removeSharedCredentialChallenge(challengeId);
  return true;
}
