#!/usr/bin/env node
// Seed the isolated Bot home with a custom provider that points at the local
// stub model server, and select it. This is what lets the real Bot stream real
// replies with no model credentials and no network egress.
//
// This is test-state seeding, not a product change: the production flow creates
// the same record through the provider wizard and a real tool-call probe.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.OPENCODE_TELEGRAM_HOME;
if (!home || !home.trim()) {
  console.error("OPENCODE_TELEGRAM_HOME is required");
  process.exit(2);
}

const modelPort = process.env.SOAK_MODEL_PORT ?? "8090";
const baseURL = `http://127.0.0.1:${modelPort}/v1`;
const providerId = "soak";
const modelId = "soak-model";
// The soak exercises run lifecycle and tool execution, not provider discovery.
// Default is to seed the verified flag so agent tools are available from the
// first cycle; set SOAK_SEED_VERIFIED=false to make the Bot run its real
// demand-driven tool-call probe against the stub instead.
const seededVerified = (process.env.SOAK_SEED_VERIFIED ?? "true") === "true";

const statePath = join(home, "app-state.json");
mkdirSync(home, { recursive: true });

let state = { version: 2 };
if (existsSync(statePath)) {
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    console.warn(`seed-state: existing ${statePath} is unreadable; replacing it`);
    state = { version: 2 };
  }
}
if (!state || typeof state !== "object" || Array.isArray(state)) state = { version: 2 };
state.version = 2;

const now = new Date().toISOString();
const providers = Array.isArray(state.customProviders?.providers)
  ? state.customProviders.providers.filter((p) => p && p.id !== providerId)
  : [];

const model = {
  id: modelId,
  name: "Soak Stub Model",
  modalities: { input: ["text"], output: ["text"] },
  toolCall: true,
  toolCallVerified: seededVerified,
};

providers.push({
  id: providerId,
  name: "Soak Stub",
  baseURL,
  apiKey: "soak-key",
  credentialId: "api-key",
  capability: "coding",
  createdAt: now,
  updatedAt: now,
  models: [model],
});

state.customProviders = { ...(state.customProviders ?? {}), providers };
state.settings = {
  ...(state.settings ?? {}),
  currentModel: { providerID: providerId, modelID: modelId, name: model.name },
};

writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(
  `seed-state: ${statePath} -> ${providerId}/${modelId} @ ${baseURL} (toolCallVerified=${seededVerified})`,
);
