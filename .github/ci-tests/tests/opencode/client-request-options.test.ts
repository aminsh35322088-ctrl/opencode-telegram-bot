import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ create: vi.fn(), promptAsync: vi.fn(), model: vi.fn(), fetches: [] as typeof fetch[] }));
vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: (config: { fetch: typeof fetch }) => {
    mocked.fetches.push(config.fetch);
    return { session: { create: mocked.create, promptAsync: mocked.promptAsync } };
  },
}));
vi.mock("../../src/config.js", () => ({ config: { opencode: { apiUrl: "http://localhost", password: "" } } }));
vi.mock("../../src/app/services/model-selection-service.js", () => ({ fetchCurrentModel: mocked.model }));
vi.mock("../../src/app/services/memory-service.js", () => ({
  searchRelevantMemories: vi.fn().mockResolvedValue([]), formatMemoriesForPrompt: () => "",
}));
vi.mock("../../src/app/services/prompt-usage-observer.js", () => ({ observePromptUsage: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { opencodeClient } from "../../src/opencode/client.js";

beforeEach(() => {
  mocked.create.mockReset().mockResolvedValue({ data: { id: "child" } });
  mocked.promptAsync.mockReset().mockResolvedValue({ data: undefined });
  mocked.model.mockReset().mockResolvedValue({ providerID: "default-provider", modelID: "default-model" });
});
afterEach(() => vi.unstubAllGlobals());

it("preserves the SDK Request cancellation signal through both bounded fetch transports", async () => {
  const network = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", network);
  for (const transport of mocked.fetches) {
    const controller = new AbortController();
    const request = new Request("http://localhost/session", { method: "POST", signal: controller.signal });
    await transport(request);
    const options = network.mock.calls.at(-1)![1] as RequestInit;
    expect(options.signal?.aborted).toBe(false);
    controller.abort();
    expect(options.signal?.aborted).toBe(true);
  }
});

it("preserves parent identity, explicit model and cancellation through the real create wrapper", async () => {
  const signal = new AbortController().signal;
  const input = { directory: "/topic", parentID: "parent", model: { providerID: "image-provider", id: "image-model" } };
  await opencodeClient.session.create(input, { signal });
  expect(mocked.create).toHaveBeenCalledWith(input, { signal });
});

it("forwards cancellation when applying the application default model", async () => {
  const signal = new AbortController().signal;
  await opencodeClient.session.create({ directory: "/topic", parentID: "parent" }, { signal });
  expect(mocked.create).toHaveBeenCalledWith({
    directory: "/topic", parentID: "parent", model: { providerID: "default-provider", id: "default-model" },
  }, { signal });
});

it("cancellation during model selection prevents child creation", async () => {
  const controller = new AbortController();
  mocked.model.mockImplementationOnce(async () => { controller.abort(); return { providerID: "p", modelID: "m" }; });
  await expect(opencodeClient.session.create({ directory: "/topic" }, { signal: controller.signal })).rejects.toThrow();
  expect(mocked.create).not.toHaveBeenCalled();
});

it("forwards the owned task signal to asynchronous prompts", async () => {
  const signal = new AbortController().signal;
  await opencodeClient.session.promptAsync({ sessionID: "child", directory: "/topic", parts: [] }, { signal });
  expect(mocked.promptAsync).toHaveBeenCalledWith(expect.objectContaining({ sessionID: "child" }), { signal });
});
