import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeMode } from "../../../src/runtime/mode.js";
import { runInTopicRuntimeContext } from "../../../src/app/services/topic-runtime-context.js";
import {
  __resetSettingsForTests,
  flushSettings,
  getDefaultImageModel,
  getEffectiveImageModel,
  getCurrentTopicImageModelOverride,
  loadSettings,
  setCurrentTopicImageModelOverride,
  setDefaultImageModel,
} from "../../../src/app/stores/settings-store.js";
import {
  ensureTopicRuntimeStateSync,
  removeTopicRuntimeState,
} from "../../../src/app/stores/topic-runtime-state-store.js";

describe("Image Model settings contract", () => {
  let tempHome: string;
  const chatId = 99101;
  const threadId = 77201;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "opencode-image-model-"));
    process.env.OPENCODE_TELEGRAM_HOME = tempHome;
    setRuntimeMode("installed");
    __resetSettingsForTests();
    await loadSettings();
  });

  afterEach(async () => {
    await removeTopicRuntimeState(chatId, threadId).catch(() => {});
    await flushSettings();
    delete process.env.OPENCODE_TELEGRAM_HOME;
    __resetSettingsForTests();
    await rm(tempHome, { recursive: true, force: true });
  });

  it("persists the global Default Image Model independently from Topic defaults", async () => {
    setDefaultImageModel({
      providerID: "cloudflare",
      modelID: "@cf/example/generate",
      editModelID: "@cf/example/edit",
    });
    await flushSettings();

    expect(getDefaultImageModel()).toEqual({
      providerID: "cloudflare",
      modelID: "@cf/example/generate",
      editModelID: "@cf/example/edit",
    });

    const state = JSON.parse(await readFile(path.join(tempHome, "app-state.json"), "utf8"));
    expect(state.settings.defaultImageModel).toEqual({
      providerID: "cloudflare",
      modelID: "@cf/example/generate",
      editModelID: "@cf/example/edit",
    });
    expect(state.settings.topicDefaults?.imageModelOverride).toBeUndefined();
  });

  it("resolves Topic override before global default and returns to the latest global default after reset", async () => {
    const firstGlobal = { providerID: "cloudflare", modelID: "global-v1" };
    const secondGlobal = { providerID: "custom-image-ai", modelID: "global-v2", editModelID: "edit-v2" };
    const topicOverride = { providerID: "custom-image-ai", modelID: "topic-model" };

    setDefaultImageModel(firstGlobal);
    ensureTopicRuntimeStateSync(chatId, threadId);

    await runInTopicRuntimeContext({ chatId, threadId }, async () => {
      expect(getCurrentTopicImageModelOverride()).toBeUndefined();
      expect(getEffectiveImageModel()).toEqual(firstGlobal);

      setCurrentTopicImageModelOverride(topicOverride);
      expect(getCurrentTopicImageModelOverride()).toEqual(topicOverride);
      expect(getEffectiveImageModel()).toEqual(topicOverride);

      setDefaultImageModel(secondGlobal);
      expect(getEffectiveImageModel()).toEqual(topicOverride);

      setCurrentTopicImageModelOverride(undefined);
      expect(getCurrentTopicImageModelOverride()).toBeUndefined();
      expect(getEffectiveImageModel()).toEqual(secondGlobal);
    });
  });

  it("does not leak mutable selection objects through getters", () => {
    setDefaultImageModel({ providerID: "cloudflare", modelID: "immutable" });
    const selection = getDefaultImageModel();
    expect(selection).toBeDefined();
    selection!.modelID = "mutated";
    expect(getDefaultImageModel()?.modelID).toBe("immutable");
  });
});
