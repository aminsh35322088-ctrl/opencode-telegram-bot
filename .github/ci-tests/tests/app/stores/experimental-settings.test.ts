import { beforeEach, describe, expect, it, vi } from "vitest";
const persisted = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));
vi.mock("../../../src/app/stores/app-state-store.js", async (original) => ({
  ...await original<typeof import("../../../src/app/stores/app-state-store.js")>(),
  readAppState: async () => ({ settings: structuredClone(persisted.settings) }),
  updateAppState: async (patch: { settings?: Record<string, unknown> }) => {
    if (patch.settings) persisted.settings = structuredClone(patch.settings);
  },
  flushAppState: async () => {},
}));
import { __resetSettingsForTests, getFreeModelDetectionEnabled, setFreeModelDetectionEnabled, loadSettings, flushSettings } from "../../../src/app/stores/settings-store.js";
import { runInTopicRuntimeContext } from "../../../src/app/services/topic-runtime-context.js";
beforeEach(() => { __resetSettingsForTests(); persisted.settings = {}; });
describe("global experimental setting", () => {
  it("defaults off and survives reloads in both directions", async () => {
    await loadSettings();
    expect(getFreeModelDetectionEnabled()).toBe(false);
    await setFreeModelDetectionEnabled(true);
    await flushSettings();
    __resetSettingsForTests(); await loadSettings();
    expect(getFreeModelDetectionEnabled()).toBe(true);
    await setFreeModelDetectionEnabled(false);
    await flushSettings();
    __resetSettingsForTests(); await loadSettings();
    expect(getFreeModelDetectionEnabled()).toBe(false);
  });
  it("is global even when toggled inside a Topic", async () => {
    await runInTopicRuntimeContext({ chatId: 1, threadId: 10 }, () => setFreeModelDetectionEnabled(true));
    expect(getFreeModelDetectionEnabled()).toBe(true);
    expect(runInTopicRuntimeContext({ chatId: 1, threadId: 20 }, getFreeModelDetectionEnabled)).toBe(true);
    expect(persisted.settings.experimentalFreeModelDetection).toBe(true);
  });
});
