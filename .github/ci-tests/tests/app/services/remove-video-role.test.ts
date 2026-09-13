import { expect, it, vi } from "vitest";

vi.mock("../../../src/app/stores/app-state-store.js", () => ({
  readAppState: async () => ({
    customProviders: { providers: [
      { id: "old-video", apiKey: "test-only", capability: "video", models: [{ id: "video-model" }] },
      { id: "chat", apiKey: "test-only", capability: "coding", models: [{ id: "chat-model" }] },
    ] },
    aiRoles: { video: { providerID: "old-video", modelID: "video-model" }, coding: { providerID: "chat", modelID: "chat-model" } },
  }),
  updateAppState: vi.fn(),
}));

import { buildOpenCodeCustomConfig, listCustomProviders, saveCustomProvider } from "../../../src/app/services/custom-provider-service.js";
import { getAiRoleSelections, setAiRoleSelection, type AiRole } from "../../../src/app/services/ai-role-selection-service.js";

it("excludes legacy video providers instead of reclassifying them as coding", async () => {
  expect((await listCustomProviders()).map(p => p.id)).toEqual(["chat"]);
  expect(JSON.parse(await buildOpenCodeCustomConfig()).provider).not.toHaveProperty("old-video");
});

it("ignores legacy video role selections", async () => {
  expect(await getAiRoleSelections()).toEqual({ coding: { providerID: "chat", modelID: "chat-model" } });
});

it("rejects video setup before discovery or storage", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await expect(saveCustomProvider({ name: "Video", baseURL: "https://example.com", apiKey: "test-only", models: [], capability: "video" as never })).rejects.toThrow("Video AI is no longer supported");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("rejects attempts to restore the removed role", async () => {
  await expect(setAiRoleSelection("video" as AiRole, "old-video", "video-model")).rejects.toThrow("Unknown AI role");
});
