import { randomUUID } from "node:crypto";
import { analyzeRemoteMcpEndpoint, createMcpServerFromInput, configureSecureMcpAuth, completeMcpOAuth, loadMcpServers, startMcpOAuth } from "./mcp-server-service.js";
import { resolveSkillSource } from "./skill-import-service.js";
import { writeGlobalSkillRaw } from "./skill-manage-service.js";
import { discoverModels, saveCustomProvider } from "./custom-provider-service.js";
import { reloadManagedOpenCodeConfig } from "./opencode-managed-config-service.js";
import { createSecureCredentialChallenge } from "./secure-credential-broker.js";
import { resolveExtensionCredential } from "./credential-vault-service.js";
import { extensionId, listExtensions } from "./extension-registry-service.js";
import { saveStoredExtension, getStoredExtension, removeStoredExtension } from "./extension-store.js";
import { generateExtensionActions } from "./extension-action-generator-service.js";
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
const oauthBySession = new Map<string, PendingOAuth>();

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
  for (const [sessionId, pending] of oauthBySession) if (pending.expiresAt <= now) oauthBySession.delete(sessionId);
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

export async function addSkillExtension(input: {
  sessionId: string;
  projectDirectory: string;
  source: string;
  confirmed?: boolean;
}): Promise<ConversationalExtensionAddResult> {
  const source = validateSource("skill", input.source);
  const resolved = await resolveSkillSource(source);
  if (resolved.kind === "list") {
    return {
      status: "question-required",
      kind: "skill",
      preview: { source, candidates: resolved.candidates },
      question: addQuestion(
        "Choose Skill",
        "Multiple skills were found. Choose one, then call skills.add again with that candidate URL.",
        resolved.candidates.slice(0, 10).map((candidate) => ({
          label: candidate.name,
          description: candidate.url,
        })),
      ),
      questionTool: {
        tool: "question",
        arguments: {
          questions: [addQuestion(
            "Choose Skill",
            "Which skill do you want to add?",
            resolved.candidates.slice(0, 10).map((candidate) => ({
              label: candidate.name,
              description: candidate.url,
            })),
          )],
        },
      },
    };
  }

  if (!input.confirmed) {
    return {
      status: "question-required",
      kind: "skill",
      preview: {
        name: resolved.skill.name,
        description: resolved.skill.description,
        source: resolved.skill.sourceUrl,
      },
      question: addQuestion(
        "Add Skill",
        `Add ${resolved.skill.name} to the bot?`,
        [
          { label: "Add", description: resolved.skill.description },
          { label: "Cancel", description: "Do not install this skill." },
        ],
      ),
      questionTool: {
        tool: "question",
        arguments: {
          questions: [addQuestion(
            "Add Skill",
            `Add ${resolved.skill.name} to the bot?`,
            [
              { label: "Add", description: resolved.skill.description },
              { label: "Cancel", description: "Do not install this skill." },
            ],
          )],
        },
      },
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

  const analysis = isLocal ? null : await analyzeRemoteMcpEndpoint(source);
  if (!input.confirmed) {
    const options: ExtensionQuestionPreview["options"] = [
      { label: "Add", description: "Use OpenCode automatic MCP authentication discovery." },
    ];
    if (analysis?.authHint === "credential-likely") {
      options.push(
        { label: "API key", description: "Add it and request an API key securely.", authType: "api-key" },
        { label: "Bearer token", description: "Add it and request a Bearer token securely.", authType: "bearer" },
      );
    }
    options.push({ label: "Cancel", description: "Do not add this Extension." });
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
      question: addQuestion(
        input.kind === "mcp" ? "Add MCP Server" : "Add Integration",
        `Add ${name} to the bot?`,
        options,
      ),
      questionTool: {
        tool: "question",
        arguments: {
          questions: [addQuestion(
            input.kind === "mcp" ? "Add MCP Server" : "Add Integration",
            `Add ${name} to the bot?`,
            options,
          )],
        },
      },
    };
  }

  const value = isLocal ? source.slice("local:".length).trim() : source;
  const server = await createMcpServerFromInput({
    projectDirectory: input.projectDirectory,
    name,
    type: isLocal ? "local" : "remote",
    value,
  });

  const requestedAuth = input.authType;
  const runtimeNeedsOAuth =
    !isLocal
    && (server.status.status === "needs_auth" || server.status.status === "needs_client_registration");
  const effectiveAuth: ExtensionAuthType =
    requestedAuth === "api-key" || requestedAuth === "bearer"
      ? requestedAuth
      : runtimeNeedsOAuth
        ? "oauth"
        : requestedAuth ?? "none";
  if (isLocal && effectiveAuth !== "none") {
    throw new Error("Local MCP Extensions do not support remote authentication.");
  }

  const requestLike: ExtensionEnsureRequest = {
    id: randomUUID(),
    sessionId: input.sessionId,
    projectDirectory: input.projectDirectory,
    name,
    kind: input.kind,
    source,
    purpose,
    authType: effectiveAuth,
    createdAt: Date.now(),
    expiresAt: Date.now() + REQUEST_TTL_MS,
    status: "installing",
  };
  const extension = recordFor(requestLike, {
    kind: "mcp",
    serverName: name,
    projectDirectory: input.projectDirectory,
  });
  const previous = await getStoredExtension(extension.id);
  if (previous) extension.createdAt = previous.createdAt;
  await saveStoredExtension(extension);

  if (effectiveAuth === "api-key" || effectiveAuth === "bearer") {
    const credentialId = effectiveAuth === "api-key" ? "api-key" : "bearer";
    const challenge = await createSecureCredentialChallenge({
      extensionId: extension.id,
      credentialId,
      sessionId: input.sessionId,
      projectDirectory: input.projectDirectory,
    });
    return {
      status: "awaiting-credential",
      extension,
      challengeId: challenge.challengeId,
      credentialId,
    };
  }

  if (effectiveAuth === "oauth") {
    const oauth = await startMcpOAuth(input.projectDirectory, name);
    oauthBySession.set(input.sessionId, {
      extensionId: extension.id,
      projectDirectory: input.projectDirectory,
      serverName: name,
      sessionId: input.sessionId,
      oauthState: oauth.oauthState,
      authorizationUrl: oauth.authorizationUrl,
      expiresAt: Date.now() + REQUEST_TTL_MS,
    });
    return {
      status: "awaiting-oauth",
      extension,
      authorizationUrl: oauth.authorizationUrl,
      oauthState: oauth.oauthState,
    };
  }

  if (server.status.status === "failed") {
    throw new Error(
      `MCP server ${name} was added but did not connect. Retry mcp.add with auth_type if the endpoint requires a credential.`,
    );
  }

  await generateExtensionActions(extension);
  return { status: "ready", extension };
}

export function getPendingExtensionOAuth(sessionId: string): PendingOAuth | null {
  prune();
  const pending = oauthBySession.get(sessionId);
  return pending ? { ...pending } : null;
}

export async function verifyPendingExtensionOAuth(sessionId: string): Promise<{
  status: "ready" | "pending";
  extension?: ExtensionRecord;
}> {
  prune();
  const pending = oauthBySession.get(sessionId);
  if (!pending) throw new Error("No extension OAuth flow is pending.");

  const servers = await loadMcpServers(pending.projectDirectory);
  const server = servers.find((item) => item.name === pending.serverName);
  if (!server || server.status.status !== "connected") return { status: "pending" };

  oauthBySession.delete(sessionId);
  const extension = await getStoredExtension(pending.extensionId);
  if (!extension) throw new Error("Extension disappeared while OAuth was pending.");
  await generateExtensionActions(extension);
  return { status: "ready", extension };
}

export async function completeExtensionOAuth(sessionId: string, callbackUrl: string): Promise<ExtensionRecord> {
  prune();
  const pending = oauthBySession.get(sessionId);
  if (!pending) throw new Error("No extension OAuth flow is pending.");
  const url = new URL(callbackUrl);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || state !== pending.oauthState || !code) throw new Error("OAuth callback does not match the pending extension.");
  await completeMcpOAuth(pending.projectDirectory, pending.serverName, code);
  oauthBySession.delete(sessionId);
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

  if (extension.resource.kind === "mcp") {
    if (extension.authType !== "bearer" && extension.authType !== "api-key") throw new Error("Unsupported MCP credential type.");
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
}
