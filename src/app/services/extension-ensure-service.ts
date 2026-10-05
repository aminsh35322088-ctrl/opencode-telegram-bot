import { resolveAuthenticatedMutationActor } from "../../control-plane/actor-context.js";
import {
  requireGlobalMutationExecution,
  assertGlobalMutationBackend,
  prepareInspectedSkillGlobalMutation,
  bindGlobalMutationQuestion,
  type GlobalMutationActor,
} from "../../control-plane/mutations.js";
import { createHash, randomUUID } from "node:crypto";
import { resolveSkillSource } from "./skill-import-service.js";
import { writeGlobalSkillRaw } from "./skill-manage-service.js";
import { reloadManagedOpenCodeConfig } from "./opencode-managed-config-service.js";
import { extensionId, listExtensions } from "./extension-registry-service.js";
import {
  saveStoredExtension,
  getStoredExtension,
  removeStoredExtension,
} from "./extension-store.js";
import { generateExtensionActions } from "./extension-action-generator-service.js";
import {
  claimSharedEnsureRequest,
  claimSharedPendingAdd,
  listSharedEnsureRequests,
  readSharedEnsureRequest,
  readSharedPendingAdd,
  removeSharedEnsureRequest,
  removeSharedPendingAdd,
  writeSharedEnsureRequest,
  writeSharedPendingAdd,
} from "./extension-automation-state-store.js";
import type { ExtensionEnsureRequest, ExtensionRecord } from "../types/extension.js";

const REQUEST_TTL_MS = 15 * 60_000;

export type ExtensionApprovalResult = { status: "ready"; extension: ExtensionRecord };
type PluginEnsureRequest = Omit<ExtensionEnsureRequest, "kind" | "authType"> & {
  kind: "plugin";
  authType: "none";
};

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
  if (
    value.startsWith("file:") ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.includes("\\")
  ) {
    throw new Error("Managed plugins must not use local/project filesystem paths.");
  }

  const markerIndex = value.indexOf(GIT_HTTPS_MARKER);
  if (markerIndex >= 0) {
    const alias = value.slice(0, markerIndex);
    if (
      alias &&
      !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@$/iu.test(alias)
    ) {
      throw new Error("Invalid git-backed plugin alias.");
    }
    let url: URL;
    try {
      url = new URL(value.slice(markerIndex + 4));
    } catch {
      throw new Error("Invalid git-backed plugin URL.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search) {
      throw new Error(
        "Git-backed plugins must use credential-free HTTPS URLs without query parameters.",
      );
    }
    const ref = url.hash.slice(1).trim();
    if (!ref || !IMMUTABLE_GIT_REF.test(ref)) {
      throw new Error(
        "Git-backed plugins must pin an immutable semantic-version tag or full commit SHA.",
      );
    }
    return value;
  }

  if (!NPM_PLUGIN_SPECIFIER.test(value)) {
    throw new Error(
      "Plugins must use a version-pinned npm specifier or git+https specifier with an explicit ref.",
    );
  }
  const version = value.slice(value.lastIndexOf("@") + 1);
  if (!version || !EXACT_SEMVER.test(version)) {
    throw new Error("Managed npm plugins must pin an exact semantic version.");
  }
  return value;
}

// Requests live on disk because they are created in the OpenCode server
// process and consumed in the Telegram bot process. Expiry and terminal
// statuses are enforced on read instead of by sweeping a local collection.

function validateSource(kind: "plugin" | "skill", source: string): string {
  const value = source.trim();
  if (!value || value.length > 4096) throw new Error("Extension source is required.");
  if (kind === "plugin") return validatePluginSpecifier(value);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Extension source must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(
      "Extension source must be an HTTP(S) URL without embedded credentials or fragments.",
    );
  }
  const sensitiveQueryKey = [...url.searchParams.keys()].find((key) =>
    /(?:^|[_-])(api[_-]?key|token|secret|password|authorization|access[_-]?token|refresh[_-]?token)(?:$|[_-])/iu.test(
      key,
    ),
  );
  if (sensitiveQueryKey) {
    throw new Error("Extension source URL must not embed credentials in query parameters.");
  }
  return url.toString();
}

function recordFor(
  request: PluginEnsureRequest,
  resource: ExtensionRecord["resource"],
): ExtensionRecord {
  const now = new Date().toISOString();
  return {
    id: extensionId(request.kind, request.name),
    name: request.name,
    kind: request.kind,
    source: request.source,
    purpose: request.purpose,
    authType: "none",
    credentialSchemas: [],
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
  kind: "plugin";
  source: string;
  purpose: string;
}): Promise<{
  status: "ready" | "approval-required";
  extensionId: string;
  requestId?: string;
  expiresAt?: number;
}> {
  const name = input.name.trim().slice(0, 100);
  const purpose = input.purpose.trim().slice(0, 500);
  if (!name || !purpose) throw new Error("Extension name and purpose are required.");
  const source = validateSource(input.kind, input.source);
  const id = extensionId(input.kind, name);
  const existing = (await listExtensions(input.projectDirectory)).find((item) => item.id === id);
  if (existing) {
    const stored = await getStoredExtension(id);
    const isPluginUpdate =
      input.kind === "plugin" && stored?.resource.kind === "plugin" && stored.source !== source;
    if (!isPluginUpdate) return { status: "ready", extensionId: id };
  }

  const now = Date.now();
  const request: PluginEnsureRequest = {
    id: randomUUID(),
    sessionId: input.sessionId,
    projectDirectory: input.projectDirectory,
    name,
    kind: input.kind,
    source,
    purpose,
    authType: "none",
    createdAt: now,
    expiresAt: now + REQUEST_TTL_MS,
    status: "awaiting-approval",
  };
  writeSharedEnsureRequest(request);
  return {
    status: "approval-required",
    extensionId: id,
    requestId: request.id,
    expiresAt: request.expiresAt,
  };
}

function isLiveApprovalRequest(
  request: ExtensionEnsureRequest | null,
): request is ExtensionEnsureRequest {
  return (
    request !== null && request.status === "awaiting-approval" && request.expiresAt > Date.now()
  );
}

function isLivePluginRequest(
  request: ExtensionEnsureRequest | null,
): request is PluginEnsureRequest {
  return isLiveApprovalRequest(request) && request.kind === "plugin" && request.authType === "none";
}

export function getExtensionEnsureRequest(id: string): ExtensionEnsureRequest | null {
  const request = readSharedEnsureRequest(id);
  return isLiveApprovalRequest(request) ? request : null;
}

export function findPendingExtensionEnsure(sessionId: string): ExtensionEnsureRequest | null {
  const matches = listSharedEnsureRequests(sessionId).filter(isLiveApprovalRequest);
  return matches.length === 1 ? matches[0]! : null;
}

export function cancelExtensionEnsure(id: string): boolean {
  if (!isLiveApprovalRequest(readSharedEnsureRequest(id))) return false;
  removeSharedEnsureRequest(id);
  return true;
}

export async function approveExtensionEnsure(id: string): Promise<ExtensionApprovalResult> {
  assertGlobalMutationBackend("extensions.ensure", id);
  // Claim by rename so a double-tap or a second Topic cannot install twice.
  const request = claimSharedEnsureRequest(id);
  if (!isLivePluginRequest(request)) throw new Error("Extension approval request expired.");

  try {
    const extension = recordFor(request, { kind: "plugin", specifier: request.source });
    const previous = await getStoredExtension(extension.id);
    if (previous) extension.createdAt = previous.createdAt;
    await saveStoredExtension(extension);
    try {
      await reloadManagedOpenCodeConfig("extension_plugin_change", { timeoutMs: 30_000 });
    } catch (error) {
      if (previous) await saveStoredExtension(previous);
      else await removeStoredExtension(extension.id);
      await reloadManagedOpenCodeConfig("extension_plugin_rollback", { timeoutMs: 30_000 }).catch(
        () => {},
      );
      throw error;
    }
    removeSharedEnsureRequest(id);
    return { status: "ready", extension };
  } catch (error) {
    // Keep a terminal record so the UI can report the failure instead of
    // silently presenting an expired-looking request.
    writeSharedEnsureRequest({
      ...request,
      status: "failed",
      error: error instanceof Error ? error.message : "Extension setup failed.",
    });
    throw error;
  }
}

export interface ExtensionQuestionPreview {
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiple: false;
}

export type ConversationalExtensionAddResult =
  | {
      status: "question-required";
      kind: "skill";
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
  source?: string;
}

interface PendingExtensionAddIntent {
  sessionId: string;
  projectDirectory: string;
  kind: "skill";
  source: string;
  name?: string;
  purpose?: string;
  inspectedContent?: string;
  inspectedHash?: string;
  approvalId?: string;
  questionRequestId?: string;
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

export function requestSkillCandidateSelection(input: {sessionId: string; projectDirectory: string; source: string; candidates: Array<{name: string; url: string}>}): Extract<ConversationalExtensionAddResult, {status: "question-required"}> {
    const candidates = input.candidates.slice(0, 10);
    const candidateOptions = candidates.map((candidate) => ({
      label: candidate.name,
      description: candidate.url,
    }));
    const question = addQuestion("Choose Skill", "Which skill do you want to add?", [
      ...candidateOptions,
      { label: "Cancel", description: "Do not install a skill from this source." },
    ]);
    writePendingAdd({
      sessionId: input.sessionId,
      projectDirectory: input.projectDirectory,
      kind: "skill",
      source: input.source,
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
      preview: { source: input.source, candidates },
      question,
      questionTool: { tool: "question", arguments: { questions: [question] } },
    };
}

export async function addSkillExtension(input: {
  sessionId: string;
  projectDirectory: string;
  source: string;
  confirmed?: boolean;
}): Promise<ConversationalExtensionAddResult> {
  if (input.confirmed)
    throw new Error("Model confirmation cannot approve a Global Skill mutation.");
  const source = validateSource("skill", input.source);
  const resolved = await resolveSkillSource(source);

  if (resolved.kind === "list") return requestSkillCandidateSelection({...input, source, candidates: resolved.candidates});

  if (!input.confirmed) {
    const question = addQuestion("Add Skill", `Add ${resolved.skill.name} to the bot?`, [
      { label: "Add", description: resolved.skill.description },
      { label: "Cancel", description: "Do not install this skill." },
    ]);
    writePendingAdd({
      sessionId: input.sessionId,
      projectDirectory: input.projectDirectory,
      kind: "skill",
      source: resolved.skill.sourceUrl || source,
      name: resolved.skill.name,
      purpose: resolved.skill.description,
      inspectedContent: resolved.skill.content,
      inspectedHash: createHash("sha256").update(resolved.skill.content).digest("hex"),
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

  throw new Error("Global Skill installation requires user Question approval.");
}

export async function installApprovedInspectedSkill(input: {
  name: string;
  content: string;
  purpose: string;
  source: string;
  sessionId: string;
}): Promise<ExtensionApprovalResult> {
  requireGlobalMutationExecution("skills.add", input.name);
  await writeGlobalSkillRaw(input.name, input.content);
  const now = new Date().toISOString();
  const id = extensionId("skill", input.name);
  const previous = await getStoredExtension(id);
  const extension: ExtensionRecord = {
    id,
    name: input.name,
    kind: "skill",
    source: input.source,
    purpose: input.purpose,
    authType: "none",
    credentialSchemas: [],
    resource: { kind: "skill", skillName: input.name },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    managed: true,
  };
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

export async function adoptPendingSkillQuestion(actor: GlobalMutationActor, requestId: string, questions: Array<{header: string; question: string}>): Promise<void> {
  const pending = readPendingAdd(actor.sessionId);
  if (!pending || pending.questionRequestId || !pending.name || !pending.inspectedContent || !pending.inspectedHash || !questions.some(q => q.header === pending.question.header && q.question === pending.question.question)) return;
  const prepared = await prepareInspectedSkillGlobalMutation(actor, {name: pending.name, content: pending.inspectedContent, contentHash: pending.inspectedHash, source: pending.source, description: pending.purpose ?? "", projectDirectory: pending.projectDirectory}, {...pending.question, options: [{label: "Add", description: pending.purpose ?? ""}, {label: "Cancel", description: "Do not install this Skill."}], multiple: false});
  writeSharedPendingAdd({...pending, approvalId: prepared.approvalId, questionRequestId: requestId});
  await bindGlobalMutationQuestion(actor, requestId, questions);
}

export type ExtensionQuestionResumeResult =
  | { handled: false }
  | { handled: true; status: "cancelled"; intent: PendingExtensionAddIntent }
  | { handled: true; status: "failed"; intent: PendingExtensionAddIntent; error: string }
  | { handled: true; status: "approval-required"; intent: PendingExtensionAddIntent; result: Awaited<ReturnType<typeof prepareInspectedSkillGlobalMutation>> }
  | {
      handled: true;
      status: "resumed";
      intent: PendingExtensionAddIntent;
      result: ExtensionApprovalResult;
    };

export async function resumePendingExtensionAddFromQuestion(input: {
  sessionId: string;
  questions: Array<{ header: string; question: string }>;
  answers: string[][];
}): Promise<ExtensionQuestionResumeResult> {
  const pending = readPendingAdd(input.sessionId);
  if (!pending) return { handled: false };

  const questionIndex = input.questions.findIndex(
    (question) =>
      question.header.trim() === pending.question.header &&
      question.question.trim() === pending.question.question,
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
    const actor = await resolveAuthenticatedMutationActor(claimed.sessionId);
    if (!actor) throw new Error("A trusted Bot Question actor is required.");
    if (claimed.name && claimed.inspectedContent && claimed.inspectedHash) {
      throw new Error("This Skill must be approved through its exact bound Question receipt.");
    }
    const resolved = await resolveSkillSource(choice.source ?? claimed.source);
    if (resolved.kind === "list") throw new Error("Select a concrete Skill source.");
    const result = await prepareInspectedSkillGlobalMutation(actor, {
      name: resolved.skill.name,
      content: resolved.skill.content,
      contentHash: createHash("sha256").update(resolved.skill.content).digest("hex"),
      source: resolved.skill.sourceUrl || choice.source || claimed.source,
      description: resolved.skill.description,
      projectDirectory: claimed.projectDirectory,
    });
    return {handled: true, status: "approval-required", intent: claimed, result};
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
    !pending ||
    pending.question.header !== input.question.header.trim() ||
    pending.question.question !== input.question.question.trim()
  ) {
    return false;
  }
  removeSharedPendingAdd(input.sessionId);
  return true;
}
