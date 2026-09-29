import { randomUUID } from "node:crypto";
import path from "node:path";

export interface TopicBindingRef {
  bindingId: string;
  chatId: number;
  threadId: number;
  sessionId: string;
  directory: string;
  bindingGeneration: number;
}

export interface TopicEnvelope extends TopicBindingRef {
  runId: string | null;
  operation: string;
  operationId: string;
  updateId?: number;
  payload: unknown;
}

export interface OutboundEnvelope extends TopicBindingRef {
  runId: string | null;
  kind: string;
  operationId: string;
  payload: unknown;
}

export type EnvelopeRejectionReason =
  | "missing_binding"
  | "stale_binding_generation"
  | "stale_run"
  | "invalid_route"
  | "invalid_run_id";

export const LIFECYCLE_OPERATIONS = new Set([
  "session.heartbeat",
  "session.status",
  "session.idle",
  "session.error",
]);

export const LIFECYCLE_OUTBOUND_KINDS = new Set([
  "session.heartbeat",
  "session.status",
  "session.idle",
  "session.error",
]);

type CurrentBinding = Pick<TopicBindingRef, "bindingGeneration"> & { runId: string | null };
type ValidationResult = { accepted: true; reason: null } | { accepted: false; reason: EnvelopeRejectionReason };

function accepted(): ValidationResult {
  return { accepted: true, reason: null };
}

function rejected(reason: EnvelopeRejectionReason): ValidationResult {
  return { accepted: false, reason };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasRequiredPayload(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, "payload");
}

function validateBindingRef(binding: TopicBindingRef): EnvelopeRejectionReason | null {
  if (!isNonEmptyString(binding.bindingId)) return "missing_binding";
  if (!Number.isFinite(binding.chatId) || !Number.isInteger(binding.chatId) || binding.chatId === 0) return "invalid_route";
  if (!Number.isFinite(binding.threadId) || !Number.isInteger(binding.threadId) || binding.threadId <= 0) return "invalid_route";
  if (!isNonEmptyString(binding.sessionId) || !isNonEmptyString(binding.directory)) return "invalid_route";
  if (!Number.isFinite(binding.bindingGeneration) || !Number.isInteger(binding.bindingGeneration) || binding.bindingGeneration <= 0) return "invalid_route";
  return null;
}

function validateRun(runId: string | null, currentRunId: string | null): EnvelopeRejectionReason | null {
  if (runId !== null && !isNonEmptyString(runId)) return "invalid_run_id";
  if (currentRunId !== null && !isNonEmptyString(currentRunId)) return "invalid_run_id";
  if (runId === null) return null;
  if (currentRunId === null || runId !== currentRunId) return "stale_run";
  return null;
}

function validateEnvelope(
  envelope: TopicBindingRef & { runId: string | null },
  current: CurrentBinding,
  allowNullRun: boolean,
): ValidationResult {
  const routeReason = validateBindingRef(envelope);
  if (routeReason) return rejected(routeReason);
  if (envelope.runId !== null && !isNonEmptyString(envelope.runId)) return rejected("invalid_run_id");
  if (envelope.runId === null && !allowNullRun) return rejected("invalid_run_id");
  if (envelope.bindingGeneration !== current.bindingGeneration) return rejected("stale_binding_generation");
  const runReason = validateRun(envelope.runId, current.runId);
  if (runReason) return rejected(runReason);
  return accepted();
}

export function validateTopicEnvelope(envelope: TopicEnvelope, current: CurrentBinding): ValidationResult {
  if (!hasRequiredPayload(envelope)) return rejected("invalid_route");
  if (!isNonEmptyString(envelope.operation) || !isNonEmptyString(envelope.operationId)) return rejected("invalid_route");
  return validateEnvelope(envelope, current, LIFECYCLE_OPERATIONS.has(envelope.operation));
}

export function validateOutboundEnvelope(envelope: OutboundEnvelope, current: CurrentBinding): ValidationResult {
  if (!hasRequiredPayload(envelope)) return rejected("invalid_route");
  if (!isNonEmptyString(envelope.kind) || !isNonEmptyString(envelope.operationId)) return rejected("invalid_route");
  return validateEnvelope(envelope, current, LIFECYCLE_OUTBOUND_KINDS.has(envelope.kind));
}

export function createRunId(): string {
  return randomUUID();
}

export function normalizeTopicDirectory(directory: string): string {
  const normalized = path.posix.normalize(directory.trim().replace(/\\/gu, "/"));
  if (normalized === ".") return "";
  const withoutTrailingSlash = normalized.replace(/\/+$/u, "");
  return (withoutTrailingSlash || "/").toLowerCase();
}
