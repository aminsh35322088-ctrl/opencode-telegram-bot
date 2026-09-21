import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenCodeCustomConfig, listCustomProviders, saveCustomProvider } from "../../../src/app/services/custom-provider-service.js";
import { getAiRoleSelections, setAiRoleSelection } from "../../../src/app/services/ai-role-selection-service.js";
import { writeAppState } from "../../../src/app/stores/app-state-store.js";
import { __resetProviderCatalogForTests } from "../../../src/app/services/provider-catalog-service.js";
import { isChatModelMetadata } from "../../../src/app/services/model-eligibility-service.js";

const request = vi.fn();
const models = [
  { id: "vision", name: "Vision", modalities: { input: ["text", "image"], output: ["text"] } },
  { id: "image", name: "Image", modalities: { input: ["text", "image"], output: ["text", "image"] } },
  { id: "speech", name: "Speech", modalities: { input: ["text"], output: ["audio"] } },
];
afterEach(async () => { await writeAppState({ version: 2 }); __resetProviderCatalogForTests(); });
beforeEach(async () => {
  await writeAppState({ version: 2 }); __resetProviderCatalogForTests();
  vi.stubGlobal("fetch", request);
  request.mockImplementation(async () => new Response(JSON.stringify({ data: models })));
});
describe("provider capability boundaries", () => {
  it("reserves built-in names and refuses implicit replacement of custom connections", async () => {
    await expect(saveCustomProvider({ name: "builtin-reserved", baseURL: "https://custom.test", apiKey: "secret", models })).rejects.toThrow("reserved");
    await saveCustomProvider({ name: "existing", baseURL: "https://custom.test", apiKey: "secret", models });
    await expect(saveCustomProvider({ name: "existing", baseURL: "https://other.test", apiKey: "secret", models })).rejects.toThrow("already exists");
  });
  it("exports the full non-STT model catalog to OpenCode for model-level capability routing", async () => {
    await saveCustomProvider({ name: "mixed", baseURL: "https://custom.test", apiKey: "secret", models });
    await saveCustomProvider({ name: "transcription", baseURL: "https://stt.test", apiKey: "secret", capability: "stt", models });
    const config = JSON.parse(await buildOpenCodeCustomConfig());
    expect(Object.keys(config.provider)).toEqual(["mixed"]);
    expect(Object.keys(config.provider.mixed.models)).toEqual(["vision", "image", "speech"]);
  });
  it("ignores legacy video selections and rejects new Video AI configuration", async () => {
    await writeAppState({ version: 2, aiRoles: { video: { providerID: "legacy", modelID: "video" } }, customProviders: { providers: [{ id: "legacy", name: "Legacy", baseURL: "https://video.test", apiKey: "secret", models, capability: "video" }] } });
    expect(await listCustomProviders()).toEqual([]); expect(await getAiRoleSelections()).toEqual({});
    await expect(saveCustomProvider({ name: "video", baseURL: "https://v.test", apiKey: "secret", models, capability: "video" as never })).rejects.toThrow("no longer supported");
    await expect(setAiRoleSelection("video" as never, "x", "y")).rejects.toThrow("Unknown AI role");
  });
  it("keeps text-capable multimodal models chat-eligible while excluding media-only output", () => {
    expect(isChatModelMetadata({ capabilities: { input: { video: true }, output: { text: true } } })).toBe(true);
    expect(isChatModelMetadata({ capabilities: { output: { text: true, image: true } } })).toBe(true);
    expect(isChatModelMetadata({ modalities: { output: ["audio"] } })).toBe(false);
  });
});
