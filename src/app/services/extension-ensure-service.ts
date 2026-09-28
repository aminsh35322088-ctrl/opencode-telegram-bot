import { randomUUID } from "node:crypto";
import { analyzeRemoteMcpEndpoint, createMcpServerFromInput, configureSecureMcpAuth, completeMcpOAuth, deleteMcpServer, loadMcpServers, startMcpOAuth } from "./mcp-server-service.js";
import { resolveSkillSource } from "./skill-import-service.js";
import { writeGlobalSkillRaw } from "./skill-manage-service.js";
import { discoverModels, saveCustomProvider } from "./custom-provider-service.js";
import { reloadManagedOpenCodeConfig } from "./opencode-managed-config-service.js";
import { createSecureCredentialChallenge } from "./secure-credential-broker.js";
import { removeExtensionCredential, resolveExtensionCredential } from "./credential-vault-service.js";
import { extensionId, listExtensions } from "./extension-registry-service.js";
import { saveStoredExtension, getStoredExtension, removeStoredExtension } from "./extension-store.js";
import { generateExtensionActions } from "./extension-action-generator-service.js";
import {
  claimSharedPendingAdd,
  readSharedPendingAdd,
  readSharedPendingOAuth,
  removeSharedPendingAdd,
  removeSharedPendingOAuth,
  writeSharedPendingAdd,
  writeSharedPendingOAuth,
} from "./extension-automation-state-store.js";
import type { ExtensionAuthType, ExtensionEnsureRequest, ExtensionKind, ExtensionRecord } from "../types/extension.js";

const REQUEST_TTL_MS = 15 * 60_000;

export type ExtensionApprovalResult =
  | { status: "ready"; extension: ExtensionRecord }
  | { status: "awaiting-credential"; extension: ExtensionRecord; challengeId: string; credentialId: string }
  | { status: "awaiting-oauth"; extension: ExtensionRecord; authorizationUrl: string; oauthState: string };

interface PendingOAuth {
  extensionId: string;
  projectDirectory: string;
  serverName: string;
  sessionId: string;
  oauthState: string;
  authorizationUrl: string;
  expiresAt: number;
}

const requests = new Map<string, ExtensionEnsureRequest>();

const NPM_PLUGIN_SPECIFIER =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@[^\s@]+$/iu;
const GIT_HTTPS_MARKER = "git+https://";
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const IMMUTABLE_GIT_REF = /^(?:v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[0-9a-f]{40})$/iu;

export function validatePluginSpecifier(source: string): string {
  const value = source.trim();
  if (!value || value.length > 2048) throw new Error("Plugin specifier is required.");
  if (/[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error("Plugin specifier must not contain whitespace or control characters.");
  }
  if (value.startsWith("file:") || value.startsWith(".") || value.startsWith("/") || value.includes("\\")) {
    throw new Error("Managed plugins must not use local/project filesystem paths.");
  }

  const markerIndex = value.indexOf(GIT_HTTPS_MARKER);
  if (markerIndex >= 0) {
    const alias = value.slice(0, markerIndex);
    if (alias && !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@$/iu.test(alias)) {
      throw new Error("Invalid git-backed plugin alias.");
    }
    let url: URL;
    try {
      url = new URL(value.slice(markerIndex + 4));
    } catch {
      throw new Error("Invalid git-backed plugin URL.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search) {
      throw new Error("Git-backed plugins must use credential-free HTTPS URLs without query parameters.");
    }
    const ref = url.hash.slice(1).trim();
    if (!ref || !IMMUTABLE_GIT_REF.test(ref)) {
      throw new Error("Git-backed plugins must pin an immutable semantic-version tag or full commit SHA.");
    }
    return value;
  }

  if (!NPM_PLUGIN_SPECIFIER.test(value)) {
    throw new Error("Plugins must use a version-pinned npm specifier or git+https specifier with an explicit ref.");
  }
  const version = value.slice(value.lastIndexOf("@") + 1);
  if (!version || !EXACT_SEMVER.test(version)) {
    throw new Error("Managed npm plugins must pin an exact semantic version.");
  }
  return value;
}

function prune(): void {
  const now = Date.now();
  for (const [id, request] of requests) if (request.expiresAt <= now || ["cancelled", "ready", "failed"].includes(request.status)) requests.delete(id);
}

function validateSource(kind: ExtensionKind, source: string): string {
  const value = source.trim();
  if (!value || value.length > 4096) throw new Error("Extension source is required.");
  if (kind === "plugin") return validatePluginSpecifier(value);
  if (kind === "mcp" && value.startsWith("local:")) {
    if (!value.slice("local:".length).trim()) throw new Error("Local MCP command is empty.");
    return value;
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Extension source must be an absolute HTTP(S) URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("Extension source must be an HTTP(S) URL without embedded credentials or fragments.");
  }
  const sensitiveQueryKey = [...url.searchParams.keys()].find((key) =>
    /(?:^|[_-])(api[_-]?key|token|secret|password|authorization|access[_-]?token|refresh[_-]?token)(?:$|[_-])/iu.test(key)
  );
  if (sensitiveQueryKey) {
    throw new Error("Extension source URL must not embed credentials in query parameters.");
  }
  return url.toString();
}

function credentialSchemas(kind: ExtensionKind, authType: ExtensionAuthType): ExtensionRecord["credentialSchemas"] {
  if (authType === "api-key") {
    return [{
      id: "api-key",
      label: kind === "model-provider" ? "Provider API key" : "API key",
      type: "api-key",
      transport: { kind: kind === "model-provider" ? "provider-api-key" : "api-key-header" },
    }];
  }
  if (authType === "bearer") {
    return [{ id: "bearer", label: "Bearer token", type: "bearer", transport: { kind: "authorization-bearer" } }];
  }
  return [];
}

function recordFor(request: ExtensionEnsureRequest, resource: ExtensionRecord["resource"]): ExtensionRecord {
  const now = new Date().toISOString();
  return {
    id: extensionId(request.kind, request.name, request.projectDirectory),
    name: request.name,
    kind: request.kind,
    source: request.source,
    purpose: request.purpose,
    authType: request.authType,
    credentialSchemas: credentialSchemas(request.kind, request.authType),
    resource,
    createdAt: now,
    updatedAt: now,
    managed: true,
  };
}

export async function requestExtensionEnsure(input: {
  sessionId: string;
  projectDirectory: string;
  name: string;
  kind: "model-provider" | "plugin";
  source: string;
  purpose: string;
  authType?: "none" | "api-key";
}): Promise<{ status: "ready" | "approval-required"; extensionId: string; requestId?: string; expiresAt?: number }> {
  prune();
  const name = input.name.trim().slice(0, 100);
  const purpose = input.purpose.trim().slice(0, 500);
  if (!name || !purpose) throw new Error("Extension name and purpose are required.");
  const source = validateSource(input.kind, input.source);
  const id = extensionId(input.kind, name, input.projectDirectory);
  const existing = (await listExtensions(input.projectDirectory)).find((item) => item.id === id);
  if (existing) {
    const stored = await getStoredExtension(id);
    const isPluginUpdate =
      input.kind === "plugin" &&
      stored?.resource.kind === "plugin" &&
      stored.source !== source;
    if (!isPluginUpdate) return { status: "ready", extensionId: id };
  }

  const now = Date.now();
  const request: ExtensionEnsureRequest = {
    id: randomUUID(),
    sessionId: input.sessionId,
    projectDirectory: input.projectDirectory,
    name,
    kind: input.kind,
    source,
    purpose,
    authType: input.authType ?? "none",
    createdAt: now,
    expiresAt: now + REQUEST_TTL_MS,
    status: "awaiting-approval",
  };
  requests.set(request.id, request);
  return { status: "approval-required", extensionId: id, requestId: request.id, expiresAt: request.expiresAt };
}

export function getExtensionEnsureRequest(id: string): ExtensionEnsureRequest | null {
  prune();
  const request = requests.get(id);
  return request ? { ...request } : null;
}

export function findPendingExtensionEnsure(sessionId: string): ExtensionEnsureRequest | null {
  prune();
  const matches = [...requests.values()].filter((request) => request.sessionId === sessionId && request.status === "awaiting-approval");
  return matches.length === 1 ? { ...matches[0]! } : null;
}

export function cancelExtensionEnsure(id: string): boolean {
  const request = requests.get(id);
  if (!request) return false;
  request.status = "cancelled";
  requests.delete(id);
  return true;
}

export async function approveExtensionEnsure(id: string): Promise<ExtensionApprovalResult> {
  prune();
  const request = requests.get(id);
  if (!request || request.status !== "awaiting-approval") throw new Error("Extension approval request expired.");
  request.status = "installing";

  try {
    if (request.kind === "plugin") {
      if (request.authType !== "none") {
        throw new Error("OpenCode plugins do not accept credentials through Extension setup.");
      }
      const extension = recordFor(request, { kind: "plugin", specifier: request.source });
      const previous = await getStoredExtension(extension.id);
      if (previous) extension.createdAt = previous.createdAt;
      await saveStoredExtension(extension);
      try {
        await reloadManagedOpenCodeConfig("extension_plugin_change", { timeoutMs: 30_000 });
      } catch (error) {
        if (previous) await saveStoredExtension(previous);
        else await removeStoredExtension(extension.id);
        await reloadManagedOpenCodeConfig("extension_plugin_rollback", { timeoutMs: 30_000 }).catch(() => {});
        throw error;
      }
      request.status = "ready";
      requests.delete(id);
      return { status: "ready", extension };
    }

    if (request.kind === "model-provider") {
      if (request.authType !== "api-key") throw new Error("Model providers currently require the registered API-key credential schema.");
      const providerId = extensionId("model-provider", request.name).slice("model-provider:".length);
      const extension = recordFor(request, { kind: "model-provider", providerId });
      await saveStoredExtension(extension);
      const challenge = await createSecureCredentialChallenge({
        extensionId: extension.id,
        credentialId: "api-key",
        sessionId: request.sessionId,
        projectDirectory: request.projectDirectory,
      });
      request.status = "awaiting-credential";
      requests.delete(id);
      return { status: "awaiting-credential", extension, challengeId: challenge.challengeId, credentialId: "api-key" };
    }

    throw new Error("Unsupported approval-based Extension kind.");
  } catch (error) {
    request.status = "failed";
    request.error = error instanceof Error ? error.message : "Extension setup failed.";
    throw error;
  }
}


export interface ExtensionQuestionPreview {
  header: string;
  question: string;
  options: Array<{ label: string; description: string; authType?: ExtensionAuthType }>;
  multiple: false;
}

export type ConversationalExtensionAddResult =
  | {
      status: "question-required";
      kind: "mcp" | "skill" | "integration";
      preview: Record<string, unknown>;
      question: ExtensionQuestionPreview;
      questionTool: {
        tool: "question";
        arguments: { questions: ExtensionQuestionPreview[] };
      };
    }
  | ExtensionApprovalResult;

function addQuestion(
  header: string,
  question: string,
  options: ExtensionQuestionPreview["options"],
): ExtensionQuestionPreview {
  return { header, question, options, multiple: false };
}

interface PendingExtensionAddChoice {
  label: string;
  action: "add" | "cancel";
  authType?: ExtensionAuthType;
  source?: string;
}

interface PendingExtensionAddIntent {
  sessionId: string;
  projectDirectory: string;
  kind: "mcp" | "skill" | "integration";
  source: string;
  name?: string;
  purpose?: string;
  question: { header: string; question: string };
  choices: PendingExtensionAddChoice[];
  createdAt: number;
  expiresAt: number;
}

function writePendingAdd(
  input: Omit<PendingExtensionAddIntent, "createdAt" | "expiresAt">,
): PendingExtensionAddIntent {
  const now = Date.now();
  const intent: PendingExtensionAddIntent = {
    ...input,
    createdAt: now,
    expiresAt: now + REQUEST_TTL_MS,
  };
  writeSharedPendingAdd(intent);
  return intent;
}

function readPendingAdd(sessionId: string): PendingExtensionAddIntent | null {
  const pending = readSharedPendingAdd<PendingExtensionAddIntent>(sessionId);
  if (!pending) return null;
  if (pending.sessionId !== sessionId || pending.expiresAt <= Date.now()) {
    removeSharedPendingAdd(sessionId);
    return null;
  }
  return pending;
}

export async function addSkillExtension(input: {
  sessionId: string;
  projectDirectory: string;
  source: string;
  confirmed?: boolean;
}): Promise<ConversationalExtensionAddResult> {
  const source = validateSource("skill", input.source);
  const resolved = await resolveSkillSource(source);

  if (resolved.kind === "list") {
    if (input.confirmed) {
      throw new Error("A concrete skill source is required before installation.");
    }
    const candidates = resolved.candidates.slice(0, 10);
    const candidateOptions = candidates.map((candidate) => ({
      label: candidate.name,
      description: candidate.url,
    }));
    const question = addQuestion(
      "Choose Skill",
      "Which skill do you want to add?",
      [...candidateOptions, { label: "Cancel", description: "Do not install a skill from this source." }],
    );
    writePendingAdd({
      sessionId: input.sessionId,
      projectDirectory: input.projectDirectory,
      kind: "skill",
      source,
      question: { header: question.header, question: question.question },
      choices: [
        ...candidates.map((candidate) => ({
          label: candidate.name,
          action: "add" as const,
          source: candidate.url,
        })),
        { label: "Cancel", action: "cancel" as const },
      ],
    });
    return {
      status: "question-required",
      kind: "skill",
      preview: { source, candidates },
      question,
      questionTool: { tool: "question", arguments: { questions: [question] } },
    };
  }

  if (!input.confirmed) {
    const question = addQuestion(
      "Add Skill",
      `Add ${resolved.skill.name} to the bot?`,
      [
        { label: "Add", description: resolved.skill.description },
        { label: "Cancel", description: "Do not install this skill." },
      ],
    );
    writePendingAdd({
      sessionId: input.sessionId,
      projectDirectory: input.projectDirectory,
      kind: "skill",
      source: resolved.skill.sourceUrl || source,
      name: resolved.skill.name,
      purpose: resolved.skill.description,
      question: { header: question.header, question: question.question },
      choices: [
        { label: "Add", action: "add" },
        { label: "Cancel", action: "cancel" },
      ],
    });
    return {
      status: "question-required",
      kind: "skill",
      preview: {
        name: resolved.skill.name,
        description: resolved.skill.description,
        source: resolved.skill.sourceUrl,
      },
      question,
      questionTool: { tool: "question", arguments: { questions: [question] } },
    };
  }

  await writeGlobalSkillRaw(resolved.skill.name, resolved.skill.content);
  const now = new Date().toISOString();
  const id = extensionId("skill", resolved.skill.name);
  const previous = await getStoredExtension(id);
  const extension: ExtensionRecord = {
    id,
    name: resolved.skill.name,
    kind: "skill",
    source: resolved.skill.sourceUrl || source,
    purpose: resolved.skill.description,
    authType: "none",
    credentialSchemas: [],
    resource: { kind: "skill", skillName: resolved.skill.name },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    managed: true,
  };
  await saveStoredExtension(extension);
  await generateExtensionActions(extension);
  removeSharedPendingAdd(input.sessionId);
  return { status: "ready", extension };
}

export async function addMcpBackedExtension(input: {
  sessionId: string;
  projectDirectory: string;
  name: string;
  source: string;
  purpose: string;
  kind: "mcp" | "integration";
  confirmed?: boolean;
  authType?: ExtensionAuthType;
}): Promise<ConversationalExtensionAddResult> {
  const name = input.name.trim().slice(0, 100);
  const purpose = input.purpose.trim().slice(0, 500);
  if (!name || !purpose) throw new Error("Extension name and purpose are required.");
  const source = validateSource(input.kind, input.source);
  const isLocal = source.startsWith("local:");
  if (input.kind === "integration" && isLocal) {
    throw new Error("Dynamic integrations may not install arbitrary local commands.");
  }

  if (!input.confirmed) {
    const analysis = isLocal ? null : await analyzeRemoteMcpEndpoint(source);
    const options: ExtensionQuestionPreview["options"] = isLocal
      ? [
          {
            label: "Add",
            description: "Add this local MCP command.",
          },
          { label: "Cancel", description: "Do not add this Extension." },
        ]
      : [
          {
            label: "Add",
            description: analysis?.authHint === "oauth-likely"
              ? "Add it and let OpenCode determine the live MCP auth state; browser sign-in will start automatically if required."
              : "Add it and let OpenCode determine the live MCP connection/auth state.",
          },
          {
            label: "API key",
            description: analysis?.authHint === "credential-likely"
              ? "Endpoint appears credential-protected. Enter an API key through secure Telegram input."
              : "Use this only if the provider gave you an API key.",
            authType: "api-key",
          },
          {
            label: "Bearer token",
            description: "Use this only if the provider gave you a Bearer token.",
            authType: "bearer",
          },
          { label: "Cancel", description: "Do not add this Extension." },
        ];

    const question = addQuestion(
      input.kind === "mcp" ? "Add MCP Server" : "Add Integration",
      `Add ${name} to the bot?`,
      options,
    );
    writePendingAdd({
      sessionId: input.sessionId,
      projectDirectory: input.projectDirectory,
      kind: input.kind,
      source,
      name,
      purpose,
      question: { header: question.header, question: question.question },
      choices: options.map((option) => ({
        label: option.label,
        action: option.label === "Cancel" ? "cancel" as const : "add" as const,
        ...(option.authType ? { authType: option.authType } : {}),
      })),
    });
    return {
      status: "question-required",
      kind: input.kind,
      preview: {
        name,
        source,
        purpose,
        transport: isLocal ? "local" : "streamable-http",
        ...(analysis ? { endpoint: analysis } : {}),
      },
      question,
      questionTool: { tool: "question", arguments: { questions: [question] } },
    };
  }

  const value = isLocal ? source.slice("local:".length).trim() : source;
  const selectedAuth = input.authType;
  if (isLocal && selectedAuth && selectedAuth !== "none") {
    throw new Error("Local MCP Extensions do not support remote authentication.");
  }

  const buildExtension = (authType: ExtensionAuthType): ExtensionRecord => {
    const requestLike: ExtensionEnsureRequest = {
      id: randomUUID(),
      sessionId: input.sessionId,
      projectDirectory: input.projectDirectory,
      name,
      kind: input.kind,
      source,
      purpose,
      authType,
      createdAt: Date.now(),
      expiresAt: Date.now() + REQUEST_TTL_MS,
      status: "installing",
    };
    return recordFor(requestLike, {
      kind: "mcp",
      serverName: name,
      projectDirectory: input.projectDirectory,
    });
  };

  if (selectedAuth === "api-key" || selectedAuth === "bearer") {
    const extension = buildExtension(selectedAuth);
    const previous = await getStoredExtension(extension.id);
    if (previous) extension.createdAt = previous.createdAt;
    await saveStoredExtension(extension);
    const credentialId = selectedAuth === "api-key" ? "api-key" : "bearer";
    const challenge = await createSecureCredentialChallenge({
      extensionId: extension.id,
      credentialId,
      sessionId: input.sessionId,
      projectDirectory: input.projectDirectory,
    });
    removeSharedPendingAdd(input.sessionId);
    return {
      status: "awaiting-credential",
      extension,
      challengeId: challenge.challengeId,
      credentialId,
    };
  }

  if (selectedAuth === "oauth") {
    throw new Error(
      "OAuth is runtime-detected for MCP Extensions; use Add and let OpenCode determine whether sign-in is required.",
    );
  }

  const server = await createMcpServerFromInput({
    projectDirectory: input.projectDirectory,
    name,
    type: isLocal ? "local" : "remote",
    value,
  });

  if (server.status.status === "failed") {
    await deleteMcpServer(input.projectDirectory, name).catch(() => false);
    throw new Error(
      `MCP server ${name} did not connect. Retry the add flow and choose API key or Bearer only when the provider explicitly requires one.`,
    );
  }

  if (server.status.status === "needs_auth" || server.status.status === "needs_client_registration") {
    const extension = buildExtension("oauth");
    const previous = await getStoredExtension(extension.id);
    if (previous) extension.createdAt = previous.createdAt;
    await saveStoredExtension(extension);
    try {
      const oauth = await startMcpOAuth(input.projectDirectory, name);
      writeSharedPendingOAuth<PendingOAuth>({
        extensionId: extension.id,
        projectDirectory: input.projectDirectory,
        serverName: name,
        sessionId: input.sessionId,
        oauthState: oauth.oauthState,
        authorizationUrl: oauth.authorizationUrl,
        expiresAt: Date.now() + REQUEST_TTL_MS,
      });
      removeSharedPendingAdd(input.sessionId);
      return {
        status: "awaiting-oauth",
        extension,
        authorizationUrl: oauth.authorizationUrl,
        oauthState: oauth.oauthState,
      };
    } catch (error) {
      await removeStoredExtension(extension.id).catch(() => {});
      await deleteMcpServer(input.projectDirectory, name).catch(() => false);
      const detail = error instanceof Error ? error.message : "OpenCode could not start OAuth.";
      throw new Error(
        `MCP server ${name} requires authentication, but native OAuth could not start: ${detail}. Retry and choose API key or Bearer only if the provider documents one of those methods.`,
      );
    }
  }

  const extension = buildExtension("none");
  const previous = await getStoredExtension(extension.id);
  if (previous) extension.createdAt = previous.createdAt;
  await saveStoredExtension(extension);
  await generateExtensionActions(extension);
  removeSharedPendingAdd(input.sessionId);
  return { status: "ready", extension };
}

function selectedQuestionLabel(value: string): string {
  const cleaned = value.replace(/^\*\s*/u, "").trim();
  const colon = cleaned.indexOf(":");
  return (colon >= 0 ? cleaned.slice(0, colon) : cleaned).trim();
}

export type ExtensionQuestionResumeResult =
  | { handled: false }
  | { handled: true; status: "cancelled"; intent: PendingExtensionAddIntent }
  | { handled: true; status: "failed"; intent: PendingExtensionAddIntent; error: string }
  | { handled: true; status: "resumed"; intent: PendingExtensionAddIntent; result: ExtensionApprovalResult };

export async function resumePendingExtensionAddFromQuestion(input: {
  sessionId: string;
  questions: Array<{ header: string; question: string }>;
  answers: string[][];
}): Promise<ExtensionQuestionResumeResult> {
  const pending = readPendingAdd(input.sessionId);
  if (!pending) return { handled: false };

  const questionIndex = input.questions.findIndex((question) =>
    question.header.trim() === pending.question.header
    && question.question.trim() === pending.question.question
  );
  if (questionIndex < 0) return { handled: false };

  const claimed = claimSharedPendingAdd<PendingExtensionAddIntent>(input.sessionId);
  if (!claimed || claimed.expiresAt <= Date.now()) return { handled: false };

  const rawAnswer = input.answers[questionIndex]?.find((answer) => answer.trim()) ?? "";
  const label = selectedQuestionLabel(rawAnswer);
  const choice = claimed.choices.find(
    (candidate) => candidate.label.toLocaleLowerCase() === label.toLocaleLowerCase(),
  );
  if (!choice) {
    return {
      handled: true,
      status: "failed",
      intent: claimed,
      error: "The Extension question answer did not match an available option.",
    };
  }

  if (choice.action === "cancel") {
    return { handled: true, status: "cancelled", intent: claimed };
  }

  try {
    if (claimed.kind === "skill") {
      const result = await addSkillExtension({
        sessionId: claimed.sessionId,
        projectDirectory: claimed.projectDirectory,
        source: choice.source ?? claimed.source,
        confirmed: true,
      });
      if (result.status === "question-required") {
        throw new Error("Skill selection did not resolve to a concrete skill.");
      }
      return { handled: true, status: "resumed", intent: claimed, result };
    }

    if (!claimed.name || !claimed.purpose) {
      throw new Error("The pending MCP/Integration add intent is incomplete.");
    }
    const result = await addMcpBackedExtension({
      sessionId: claimed.sessionId,
      projectDirectory: claimed.projectDirectory,
      name: claimed.name,
      source: claimed.source,
      purpose: claimed.purpose,
      kind: claimed.kind,
      confirmed: true,
      ...(choice.authType ? { authType: choice.authType } : {}),
    });
    if (result.status === "question-required") {
      throw new Error("Extension add unexpectedly returned another question.");
    }
    return { handled: true, status: "resumed", intent: claimed, result };
  } catch (error) {
    return {
      handled: true,
      status: "failed",
      intent: claimed,
      error: error instanceof Error ? error.message : "Extension setup failed.",
    };
  }
}

export function cancelPendingExtensionAddForQuestion(input: {
  sessionId: string;
  question: { header: string; question: string };
}): boolean {
  const pending = readPendingAdd(input.sessionId);
  if (
    !pending
    || pending.question.header !== input.question.header.trim()
    || pending.question.question !== input.question.question.trim()
  ) {
    return false;
  }
  removeSharedPendingAdd(input.sessionId);
  return true;
}

export function getPendingExtensionOAuth(sessionId: string): PendingOAuth | null {
  prune();
  const pending = readSharedPendingOAuth<PendingOAuth>(sessionId);
  if (!pending) return null;
  if (pending.expiresAt <= Date.now()) {
    removeSharedPendingOAuth(sessionId);
    return null;
  }
  return { ...pending };
}

export async function verifyPendingExtensionOAuth(sessionId: string): Promise<{
  status: "ready" | "pending";
  extension?: ExtensionRecord;
}> {
  prune();
  const pending = getPendingExtensionOAuth(sessionId);
  if (!pending) throw new Error("No extension OAuth flow is pending.");

  const servers = await loadMcpServers(pending.projectDirectory);
  const server = servers.find((item) => item.name === pending.serverName);
  if (!server || server.status.status !== "connected") return { status: "pending" };

  removeSharedPendingOAuth(sessionId);
  const extension = await getStoredExtension(pending.extensionId);
  if (!extension) throw new Error("Extension disappeared while OAuth was pending.");
  await generateExtensionActions(extension);
  return { status: "ready", extension };
}

export async function completeExtensionOAuth(sessionId: string, callbackUrl: string): Promise<ExtensionRecord> {
  prune();
  const pending = getPendingExtensionOAuth(sessionId);
  if (!pending) throw new Error("No extension OAuth flow is pending.");
  const url = new URL(callbackUrl);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || state !== pending.oauthState || !code) throw new Error("OAuth callback does not match the pending extension.");
  await completeMcpOAuth(pending.projectDirectory, pending.serverName, code);
  removeSharedPendingOAuth(sessionId);
  const extension = await getStoredExtension(pending.extensionId);
  if (!extension) throw new Error("Extension disappeared while OAuth was pending.");
  await generateExtensionActions(extension);
  return extension;
}

export async function finalizeExtensionCredential(extensionIdValue: string): Promise<ExtensionRecord> {
  const extension = await getStoredExtension(extensionIdValue);
  if (!extension) throw new Error("Extension is not registered.");
  const schema = extension.credentialSchemas[0];
  if (!schema) throw new Error("Extension does not declare a credential schema.");
  const secret = await resolveExtensionCredential(extension.id, schema.id);
  if (!secret) throw new Error("Extension credential is missing.");

  try {
    if (extension.resource.kind === "mcp") {
      if (extension.authType !== "bearer" && extension.authType !== "api-key") {
        throw new Error("Unsupported MCP credential type.");
      }
      if (extension.authType === "bearer") {
        await configureSecureMcpAuth({
          projectDirectory: extension.resource.projectDirectory,
          serverName: extension.resource.serverName,
          remoteUrl: extension.source,
          mode: "bearer",
          secret,
        });
      } else {
        await configureSecureMcpAuth({
          projectDirectory: extension.resource.projectDirectory,
          serverName: extension.resource.serverName,
          remoteUrl: extension.source,
          mode: "api-key",
          headerName: "X-API-Key",
          secret,
        });
      }
      await generateExtensionActions(extension);
      return extension;
    }

    if (extension.resource.kind === "model-provider") {
      const models = await discoverModels(extension.source, secret);
      await saveCustomProvider({
        id: extension.resource.providerId,
        name: extension.name,
        baseURL: extension.source,
        apiKey: secret,
        models,
        capability: "general",
      });
      return extension;
    }

    throw new Error("Credential finalization is not supported for this extension.");
  } catch (error) {
    await removeExtensionCredential(extension.id, schema.id).catch(() => {});
    throw error;
  }
}
