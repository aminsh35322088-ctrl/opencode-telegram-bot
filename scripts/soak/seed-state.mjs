#!/usr/bin/env node
// Seed the isolated Bot home with a custom provider that points at the local
// stub model server, and select it. This is what lets the real Bot stream real
// replies with no model credentials and no network egress.
//
// This is test-state seeding, not a product change: the production flow creates
// the same record through the provider wizard and a real tool-call probe.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The settings half of the seed, exported so the soak harness contract — which
// mode the Bot is seeded into — is testable without writing a home directory.
export function settingsPatch({ providerId, modelId, modelName }) {
  return {
    currentModel: { providerID: providerId, modelID: modelId, name: modelName },
    // Telegram's Stop exists only on drafts. The Bot's default streaming mode
    // is `edit`, which never issues one, so a native Stop arrives with an id
    // the Bot never registered and is refused as `unknown-draft`. The soak must
    // run in the mode the Stop contract is written against; seed it globally
    // and as the default every new Topic is created with.
    responseStreamingMode: "draft",
    topicDefaults: { responseStreamingMode: "draft" },
  };
}

function main() {
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
  const patch = settingsPatch({ providerId, modelId, modelName: model.name });
  state.settings = {
    ...(state.settings ?? {}),
    ...patch,
    // Merge, never replace: re-seeding an existing home must not drop topic
    // defaults recorded by an earlier run.
    topicDefaults: { ...(state.settings?.topicDefaults ?? {}), ...(patch.topicDefaults ?? {}) },
  };

  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(
    `seed-state: ${statePath} -> ${providerId}/${modelId} @ ${baseURL} (toolCallVerified=${seededVerified})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
