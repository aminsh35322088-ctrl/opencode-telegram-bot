import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenCodeCustomConfig, listCustomProviders, saveCustomProvider } from "../../../src/app/services/custom-provider-service.js";
import { buildToolImageChatProfile, configureGeminiImageConnection, validateImageChatProfile } from "../../../src/app/services/image-chat-profile-service.js";
import { getAiRoleSelections, setAiRoleSelection } from "../../../src/app/services/ai-role-selection-service.js";
import { readAppState, writeAppState } from "../../../src/app/stores/app-state-store.js";
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
describe("provider separation and setup", () => {
  it("reserves built-in names and refuses implicit replacement of custom connections", async () => {
    await expect(saveCustomProvider({ name: "builtin-reserved", baseURL: "https://custom.test", apiKey: "secret", models })).rejects.toThrow("reserved");
    await saveCustomProvider({ name: "existing", baseURL: "https://custom.test", apiKey: "secret", models });
    await expect(saveCustomProvider({ name: "existing", baseURL: "https://other.test", apiKey: "secret", models })).rejects.toThrow("already exists");
  });
  it("exports only coding connections and text output models to OpenCode", async () => {
    await saveCustomProvider({ name: "mixed", baseURL: "https://custom.test", apiKey: "secret", models });
    await saveCustomProvider({ name: "transcription", baseURL: "https://stt.test", apiKey: "secret", capability: "stt", models });
    const config = JSON.parse(await buildOpenCodeCustomConfig());
    expect(Object.keys(config.provider)).toEqual(["mixed"]);
    expect(Object.keys(config.provider.mixed.models)).toEqual(["vision"]);
  });
  it("ignores legacy video selections and rejects new Video AI configuration", async () => {
    await writeAppState({ version: 2, aiRoles: { video: { providerID: "legacy", modelID: "video" } }, customProviders: { providers: [{ id: "legacy", name: "Legacy", baseURL: "https://video.test", apiKey: "secret", models, capability: "video" }] } });
    expect(await listCustomProviders()).toEqual([]); expect(await getAiRoleSelections()).toEqual({});
    await expect(saveCustomProvider({ name: "video", baseURL: "https://v.test", apiKey: "secret", models, capability: "video" as never })).rejects.toThrow("no longer supported");
    await expect(setAiRoleSelection("video" as never, "x", "y")).rejects.toThrow("Unknown AI role");
  });
  it("keeps video input on text models while excluding media output", () => {
    expect(isChatModelMetadata({ capabilities: { input: { video: true }, output: { text: true } } })).toBe(true);
    expect(isChatModelMetadata({ capabilities: { output: { text: true, image: true } } })).toBe(false);
    expect(isChatModelMetadata({ modalities: { output: ["audio"] } })).toBe(false);
  });
  it("checks Gemini model access without issuing generation requests", async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ supportedGenerationMethods: ["generateContent"] })));
    const profile = await configureGeminiImageConnection("gemini-key", "user-chosen-image-model");
    expect(profile.modelID).toBe("user-chosen-image-model");
    expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0]?.[0]).toContain("/models/user-chosen-image-model");
    expect(request.mock.calls[0]?.[1].method).toBeUndefined();
  });
  it("pins both image models and endpoint and rejects changed connections", async () => {
    await saveCustomProvider({ name: "chat", baseURL: "https://custom.test/v1", apiKey: "secret", models });
    const image = { id: "custom-image-ai", name: "Image", baseURL: "https://image.test/v1", apiKey: "secret", model: "draw", editModel: "edit", capabilities: ["generate", "edit"], active: true };
    await writeAppState({ ...(await readAppState()), imageAi: { providers: [image] } });
    const profile = await buildToolImageChatProfile("chat", "vision", "custom-image-ai");
    expect(profile.imageEndpoint).toBe(image.baseURL);
    await writeAppState({ ...(await readAppState()), imageAi: { providers: [{ ...image, baseURL: "https://other.test/v1" }] } });
    await expect(validateImageChatProfile(profile)).rejects.toThrow("settings changed");
    await expect(buildToolImageChatProfile("chat", "image", "custom-image-ai")).rejects.toThrow("conversation connection/model");
  });
});