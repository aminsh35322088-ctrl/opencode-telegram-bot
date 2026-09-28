import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { isRecord } from "../../utils/type-guards.js";

export interface ProviderFreePolicy {
  providerId: string;
  freeSuffix?: string;
  freeModels: string[];
  paidByDefault: boolean;
  confidence: "low" | "medium" | "high";
  source?: string;
  updatedAt: string;
}

interface PolicyState {
  version: 1;
  policies: Record<string, ProviderFreePolicy>;
}

const STORE_KEY = "providerFreePolicies";

function parseState(value: unknown): PolicyState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.policies)) return { version: 1, policies: {} };
  const policies: Record<string, ProviderFreePolicy> = {};
  for (const [providerId, candidate] of Object.entries(value.policies)) {
    if (
      !isRecord(candidate) ||
      candidate.providerId !== providerId ||
      !Array.isArray(candidate.freeModels) ||
      typeof candidate.paidByDefault !== "boolean" ||
      !["low", "medium", "high"].includes(String(candidate.confidence)) ||
      typeof candidate.updatedAt !== "string"
    ) continue;
    policies[providerId] = {
      providerId,
      ...(typeof candidate.freeSuffix === "string" && candidate.freeSuffix ? { freeSuffix: candidate.freeSuffix } : {}),
      freeModels: candidate.freeModels.filter((item): item is string => typeof item === "string").slice(0, 500),
      paidByDefault: candidate.paidByDefault,
      confidence: candidate.confidence as ProviderFreePolicy["confidence"],
      ...(typeof candidate.source === "string" && candidate.source ? { source: candidate.source } : {}),
      updatedAt: candidate.updatedAt,
    };
  }
  return { version: 1, policies };
}

export async function getProviderFreePolicy(providerId: string): Promise<ProviderFreePolicy | null> {
  const state = await readAppState();
  return parseState(state[STORE_KEY]).policies[providerId] ?? null;
}

export async function setProviderFreePolicy(input: Omit<ProviderFreePolicy, "updatedAt">): Promise<ProviderFreePolicy> {
  const policy: ProviderFreePolicy = {
    providerId: input.providerId.trim(),
    ...(input.freeSuffix?.trim() ? { freeSuffix: input.freeSuffix.trim() } : {}),
    freeModels: [...new Set(input.freeModels.map((item) => item.trim()).filter(Boolean))].slice(0, 500),
    paidByDefault: input.paidByDefault,
    confidence: input.confidence,
    ...(input.source?.trim() ? { source: input.source.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (!policy.providerId) throw new Error("Provider ID is required.");
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    return { [STORE_KEY]: { version: 1, policies: { ...current.policies, [policy.providerId]: policy } } };
  });
  return policy;
}
