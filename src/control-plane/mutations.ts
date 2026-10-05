import { createHash, randomUUID } from "node:crypto";
import { commitGlobalMutation } from "./global-state.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readAppState, updateAppState } from "../app/stores/app-state-store.js";

export interface GlobalMutationActor {
  nodeId: string;
  generation: number;
  chatId: number;
  threadId: number;
  sessionId: string;
}
export interface GlobalMutation {
  type: string;
  resource: string;
  config: Record<string, unknown>;
}
export interface PendingGlobalMutation extends GlobalMutation {
  approvalId: string;
  actorTopicId: string;
  sessionId: string;
  nodeId: string;
  generation: number;
  configHash: string;
  expiresAt: number;
  nonce: string;
  status: "pending" | "approved" | "committing" | "committed" | "rejected" | "failed";
  questionRequestId?: string;
  approveLabel?: string;
  question: {
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiple: false;
  };
}
const execution = new AsyncLocalStorage<PendingGlobalMutation>();
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
export function globalMutationConfigHash(mutation: GlobalMutation): string {
  return createHash("sha256").update(stable(mutation)).digest("hex");
}
function ledger(state: Record<string, unknown>): Record<string, PendingGlobalMutation> {
  return (state.globalMutationApprovals ?? {}) as Record<string, PendingGlobalMutation>;
}
function topic(actor: GlobalMutationActor): string {
  return `${actor.chatId}:${actor.threadId}`;
}
function matches(pending: PendingGlobalMutation, actor: GlobalMutationActor): boolean {
  return (
    pending.actorTopicId === topic(actor) &&
    pending.sessionId === actor.sessionId &&
    pending.nodeId === actor.nodeId &&
    pending.generation === actor.generation
  );
}
export async function prepareGlobalMutation(actor: GlobalMutationActor, input: GlobalMutation) {
  if (!actor.nodeId || !actor.sessionId || !Number.isSafeInteger(actor.generation))
    throw new Error("A bound mutation actor is required.");
  const mutation = JSON.parse(
    JSON.stringify({ ...input, resource: input.resource.trim() }),
  ) as GlobalMutation;
  if (!mutation.type || !mutation.resource)
    throw new Error("Mutation type and resource are required.");
  if (mutation.type === "skills.add") {
    const { resolveSkillSource } = await import("../app/services/skill-import-service.js");
    const source = mutation.config.source;
    if (typeof source !== "string") throw new Error("Skill source is required.");
    const resolved = await resolveSkillSource(source);
    if (resolved.kind === "list") {
      const { requestSkillCandidateSelection } = await import("../app/services/extension-ensure-service.js");
      if (typeof mutation.config.projectDirectory !== "string") throw new Error("Skill project directory is required.");
      return { ...requestSkillCandidateSelection({sessionId: actor.sessionId, projectDirectory: mutation.config.projectDirectory, source, candidates: resolved.candidates}), stage: "selection" as const };
    }
    mutation.resource = resolved.skill.name;
    mutation.config = {
      ...mutation.config,
      source: resolved.skill.sourceUrl || source,
      content: resolved.skill.content,
      contentHash: createHash("sha256").update(resolved.skill.content).digest("hex"),
      description: resolved.skill.description,
    };
  }
  if (mutation.type === "extensions.ensure") {
    const { validatePluginSpecifier } = await import("../app/services/extension-ensure-service.js");
    if (typeof mutation.config.source !== "string") throw new Error("Plugin source is required.");
    mutation.config.source = validatePluginSpecifier(mutation.config.source);
  }
  if (mutation.type === "mcp.add" && mutation.config.type === "remote") {
    const { analyzeRemoteMcpEndpoint } = await import("../app/services/mcp-server-service.js");
    if (typeof mutation.config.value !== "string") throw new Error("MCP endpoint is required.");
    const endpoint = new URL(mutation.config.value);
    if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
      throw new Error("MCP endpoint must be credential-free HTTP(S).");
    mutation.config.value = endpoint.toString();
    mutation.config.inspection = await analyzeRemoteMcpEndpoint(endpoint.toString());
  }

  return await persistPreparedGlobalMutation(actor, mutation);
}
async function persistPreparedGlobalMutation(actor: GlobalMutationActor, mutation: GlobalMutation, existingQuestion?: PendingGlobalMutation["question"]) {
  const approvalId = randomUUID();
  const pending: PendingGlobalMutation = {
    ...mutation,
    approvalId,
    actorTopicId: topic(actor),
    sessionId: actor.sessionId,
    nodeId: actor.nodeId,
    generation: actor.generation,
    nonce: randomUUID(),
    configHash: globalMutationConfigHash(mutation),
    expiresAt: Date.now() + 15 * 60_000,
    status: "pending",
    question: {
      header: "Global Change",
      question: `Approve ${mutation.type} for ${mutation.resource}? Approval: ${approvalId}`,
      options: [
        { label: "Approve", description: "Apply this exact inspected Global change." },
        { label: "Reject", description: "Leave Global unchanged." },
      ],
      multiple: false,
    },
  };
  if (existingQuestion) { pending.question = existingQuestion; pending.approveLabel = "Add"; }
  await updateAppState((state) => ({
    globalMutationApprovals: { ...ledger(state), [approvalId]: pending },
  }));
  return {
    status: "question-required" as const,
    approvalId,
    configHash: pending.configHash,
    expiresAt: pending.expiresAt,
    preview: mutation,
    question: pending.question,
    questionTool: { tool: "question", arguments: { questions: [pending.question] } },
  };
}
/** Trusted Bot adapter for bytes already inspected before a legacy Skill Question. */
export async function prepareInspectedSkillGlobalMutation(actor: GlobalMutationActor, input: {name: string; content: string; contentHash: string; source: string; description: string; projectDirectory: string}, existingQuestion?: PendingGlobalMutation["question"]) {
  const { resolveAuthenticatedMutationActor } = await import("./actor-context.js");
  const trusted = await resolveAuthenticatedMutationActor(actor.sessionId);
  if (!trusted || stable(trusted) !== stable(actor)) throw new Error("Inspected Skill preparation requires a trusted Bot actor.");
  if (createHash("sha256").update(input.content).digest("hex") !== input.contentHash) throw new Error("Inspected Skill bytes changed.");
  return await persistPreparedGlobalMutation(actor, {type: "skills.add", resource: input.name, config: {content: input.content, contentHash: input.contentHash, source: input.source, description: input.description, projectDirectory: input.projectDirectory}}, existingQuestion);
}
export async function bindGlobalMutationQuestion(
  actor: GlobalMutationActor,
  requestId: string,
  questions: Array<{ header: string; question: string }>,
) {
  await updateAppState((state) => {
    const next = { ...ledger(state) };
    for (const [id, pending] of Object.entries(next)) {
      if (
        pending.status === "pending" &&
        !pending.questionRequestId &&
        pending.expiresAt > Date.now() &&
        matches(pending, actor) &&
        questions.some(
          (q) => q.header === pending.question.header && q.question === pending.question.question,
        )
      )
        next[id] = { ...pending, questionRequestId: requestId };
    }
    return { globalMutationApprovals: next };
  });
}
/** Called only by trusted Telegram Question handlers, never dispatched through model RPC. */
export async function handleApprovedGlobalQuestion(input: {
  actor: GlobalMutationActor;
  requestId: string;
  questions: Array<{ header: string; question: string }>;
  answers: string[][];
}) {
  assertGlobalMutationBackend("question.approve", input.requestId);
  let selected: PendingGlobalMutation | undefined;
  await updateAppState((state) => {
    const next = { ...ledger(state) };
    for (const [id, pending] of Object.entries(next)) {
      const index = input.questions.findIndex(
        (q) => q.header === pending.question.header && q.question === pending.question.question,
      );
      if (
        index < 0 ||
        !matches(pending, input.actor) ||
        pending.questionRequestId !== input.requestId ||
        pending.status !== "pending" ||
        pending.expiresAt <= Date.now()
      )
        continue;
      const answers = input.answers[index];
      const approved = answers?.length === 1 && answers[0] === (pending.approveLabel ?? "Approve");
      selected = { ...pending, status: approved ? "approved" : "rejected" };
      next[id] = selected;
    }
    return { globalMutationApprovals: next };
  });
  return selected ?? null;
}
export function requireGlobalMutationExecution(type: string, resource: string): void {
  const pending = execution.getStore();
  if (!pending || pending.type !== type || pending.resource !== resource)
    throw new Error("Global mutation requires exact user Question approval.");
}
export async function commitGlobalMutationApproved(
  actor: GlobalMutationActor,
  approvalId: string,
  mutation: GlobalMutation,
  apply: (pending: PendingGlobalMutation) => Promise<unknown>,
): Promise<unknown> {
  let claimed: PendingGlobalMutation | undefined;
  let alreadyCommitted = false;
  let alreadyCommitting = false;
  await updateAppState((state) => {
    const next = { ...ledger(state) };
    const pending = next[approvalId];
    if (
      !pending ||
      pending.configHash !==
        globalMutationConfigHash({
          type: pending.type,
          resource: pending.resource,
          config: pending.config,
        }) ||
      !matches(pending, actor) ||
      pending.configHash !== globalMutationConfigHash(mutation) ||
      pending.type !== mutation.type ||
      pending.resource !== mutation.resource
    )
      throw new Error("Approval does not match this actor or exact mutation.");
    if (pending.status === "committed") {
      alreadyCommitted = true;
      return {};
    }
    if (pending.status === "committing") {
      alreadyCommitting = true;
      return {};
    }
    if (pending.status !== "approved" || pending.expiresAt <= Date.now())
      throw new Error("Global approval is unavailable or expired.");
    claimed = { ...pending, status: "committing" };
    next[approvalId] = claimed;
    return { globalMutationApprovals: next };
  });
  if (alreadyCommitted) return { status: "committed", approvalId };
  if (alreadyCommitting) return { status: "committing", approvalId };
  if (!claimed) throw new Error("Approval was not claimed.");
  try {
    let result: unknown;
    const snapshot = await commitGlobalMutation(
      {
        type: claimed.type,
        resource: claimed.resource,
        actorTopicId: claimed.actorTopicId,
        sessionId: claimed.sessionId,
        configHash: claimed.configHash,
        approvalId,
      },
      async () => {
        result = await execution.run(claimed!, () => apply(claimed!));
      },
    );
    await updateAppState((state) => ({
      globalMutationApprovals: {
        ...ledger(state),
        [approvalId]: { ...claimed!, status: "committed" },
      },
    }));
    return {
      status: "committed",
      approvalId,
      result,
      revision: snapshot.revision,
      hash: snapshot.hash,
    };
  } catch (error) {
    await updateAppState((state) => ({
      globalMutationApprovals: {
        ...ledger(state),
        [approvalId]: { ...claimed!, status: "failed" },
      },
    }));
    throw error;
  }
}
export async function readGlobalMutationApproval(approvalId: string) {
  return ledger(await readAppState())[approvalId] ?? null;
}

/** Fixed dispatcher: RPC callers can supply data, never an executable mutation callback. */
export async function applyApprovedGlobalMutation(
  pending: PendingGlobalMutation,
): Promise<unknown> {
  const config = pending.config;
  const text = (key: string): string => {
    const value = config[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Mutation requires ${key}.`);
    return value;
  };
  if (pending.type.startsWith("skills.")) {
    const skills = await import("../app/services/skill-manage-service.js");
    if (pending.type === "skills.delete") return await skills.deleteGlobalSkill(pending.resource);
    if (pending.type === "skills.add") {
      const content = text("content");
      if (createHash("sha256").update(content).digest("hex") !== text("contentHash"))
        throw new Error("Inspected Skill content integrity check failed.");
      const extensions = await import("../app/services/extension-ensure-service.js");
      return await extensions.installApprovedInspectedSkill({
        name: pending.resource,
        content,
        source: text("source"),
        purpose: text("description"),
        sessionId: pending.sessionId,
      });
    }
    const input = { name: pending.resource, description: text("description"), body: text("body") };
    if (pending.type === "skills.create") return await skills.writeGlobalSkill(input);
    if (pending.type === "skills.update") return await skills.updateGlobalSkill(input);
  }
  if (pending.type.startsWith("mcp.")) {
    const mcp = await import("../app/services/mcp-server-service.js");
    const directory = text("projectDirectory");
    if (pending.type === "mcp.add") {
      if (config.type !== "local" && config.type !== "remote")
        throw new Error("Invalid MCP transport.");
      return await mcp.createMcpServerFromInput({
        projectDirectory: directory,
        name: pending.resource,
        type: config.type,
        value: text("value"),
      });
    }
    if (pending.type === "mcp.delete")
      return await mcp.deleteMcpServer(directory, pending.resource);
    if (pending.type === "mcp.rename")
      return await mcp.renameMcpServer(directory, pending.resource, text("newName"));
    if (pending.type === "mcp.enable") {
      if (typeof config.enabled !== "boolean") throw new Error("MCP enabled must be a boolean.");
      return await mcp.setMcpServerEnabled(directory, pending.resource, config.enabled);
    }
  }
  if (pending.type === "generated-actions.toggle") {
    if (typeof config.enabled !== "boolean") throw new Error("Action enabled must be a boolean.");
    const actions = await import("../app/services/generated-action-store.js");
    return await actions.setGeneratedActionEnabled(pending.resource, config.enabled);
  }
  if (pending.type === "extensions.remove") {
    const extensions = await import("../app/services/extension-registry-service.js");
    return await extensions.removeExtension(text("projectDirectory"), pending.resource);
  }
  if (pending.type === "extensions.ensure") {
    const extensions = await import("../app/services/extension-ensure-service.js");
    const result = await extensions.requestExtensionEnsure({
      sessionId: pending.sessionId,
      projectDirectory: text("projectDirectory"),
      name: pending.resource,
      kind: "plugin",
      source: text("source"),
      purpose: text("purpose"),
    });
    if (!result.requestId) return result;
    return await extensions.approveExtensionEnsure(result.requestId);
  }
  throw new Error("Unsupported Global mutation type.");
}
export async function commitPreparedGlobalMutation(
  actor: GlobalMutationActor,
  approvalId: string,
  mutation: GlobalMutation,
) {
  return await commitGlobalMutationApproved(
    actor,
    approvalId,
    mutation,
    applyApprovedGlobalMutation,
  );
}

const trustedTelegramUi = new AsyncLocalStorage<Readonly<{ type: string; resource: string }>>();
/** Internal Telegram UI entry; never exposed by the model RPC dispatcher. */
export function runTrustedTelegramGlobalMutation<T>(
  type: string,
  resource: string,
  apply: () => T,
): T {
  return trustedTelegramUi.run(Object.freeze({ type, resource }), apply);
}
export function assertGlobalMutationBackend(type: string, resource: string): void {
  const approved = execution.getStore();
  if (
    approved &&
    ((approved.type === type && approved.resource === resource) ||
      (approved.type === "extensions.ensure" && type === "extensions.ensure") ||
      (approved.type === "extensions.remove" &&
        ["skills.delete", "mcp.delete"].includes(type)))
  )
    return;
  const ui = trustedTelegramUi.getStore();
  if (ui && ((ui.type === type && ui.resource === resource) || (ui.type === "extensions.remove" && ["skills.delete", "mcp.delete"].includes(type))))
    return;
  throw new Error("Global mutation requires an approved Question or trusted Telegram UI action.");
}
