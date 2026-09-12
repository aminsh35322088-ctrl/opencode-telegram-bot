import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ enabled: false, revision: "a", models: [] as any[], prices: new Map(), topic: undefined as unknown }));
vi.mock("../../../src/app/stores/settings-store.js", async (original) => ({
  ...await original<typeof import("../../../src/app/stores/settings-store.js")>(),
  getFreeModelDetectionEnabled: () => state.enabled,
  getCurrentTopicSettings: () => state.topic,
}));
vi.mock("../../../src/app/services/model-price-service.js", () => ({
  getProviderModelPrices: vi.fn(async () => new Map(state.prices)),
  getProviderPriceRevision: vi.fn(async () => state.revision),
}));
vi.mock("../../../src/app/services/model-selection-service.js", async (original) => ({
  ...await original<typeof import("../../../src/app/services/model-selection-service.js")>(),
  getProviderModels: async () => state.models,
}));
vi.mock("../../../src/app/services/model-preferences-service.js", () => ({ getFavoriteModels: async () => [], getRecentModels: async () => [] }));
import { buildSettingsMenuView, buildExperimentalSettingsView, SETTINGS_EXPERIMENTAL_CALLBACK, SETTINGS_ADVANCED_CALLBACK } from "../../../src/bot/menus/settings-menu.js";
import { buildModelCenterProvider, resolveModelCenterAction, resolveModelCenterFavoriteTarget } from "../../../src/bot/menus/model-center-menu.js";
import { clearProviderPriceViews, getProviderPriceView } from "../../../src/bot/menus/provider-price-view.js";
import { getProviderModelPrices } from "../../../src/app/services/model-price-service.js";
const provider = { id: "p", name: "Provider", modelCount: 10 };
beforeEach(() => {
  clearProviderPriceViews(); state.enabled = false; state.revision = "a"; state.topic = undefined;
  state.models = Array.from({ length: 10 }, (_, i) => ({ providerID: "p", modelID: "model-" + i, name: "Model " + i }));
  state.prices = new Map([["model-0", { group: "paid" }], ["model-9", { group: "free" }]]);
});
describe("minimal experimental price UI", () => {
  it("places Experimental immediately above Advanced in global settings", () => {
    const rows = buildSettingsMenuView().keyboard.inline_keyboard;
    const advanced = rows.findIndex((row) => row.some((b: any) => b.callback_data === SETTINGS_ADVANCED_CALLBACK));
    expect((rows[advanced - 1][0] as any).callback_data).toBe(SETTINGS_EXPERIMENTAL_CALLBACK);
    expect(buildExperimentalSettingsView().keyboard.inline_keyboard[0][0].text).toContain("OFF");
    state.topic = { model: { providerID: "p", modelID: "m" } };
    expect(buildSettingsMenuView().keyboard.inline_keyboard.flat().some((b: any) => b.callback_data === SETTINGS_EXPERIMENTAL_CALLBACK)).toBe(false);
  });
  it("leaves disabled lists unchanged without price work", async () => {
    const view = await buildModelCenterProvider(provider, 0);
    expect(view.keyboard.inline_keyboard[0][0].text).toBe("🧠 Model 0");
    expect(view.keyboard.inline_keyboard.flat().some((b) => b.text === "ⓘ Colors")).toBe(false);
    expect(getProviderModelPrices).not.toHaveBeenCalled();
  });
  it("shows one price color, current check and the existing favorite button", async () => {
    state.enabled = true;
    const view = await buildModelCenterProvider(provider, 0, { providerID: "p", modelID: "model-9", variant: "default" });
    const [select, favorite] = view.keyboard.inline_keyboard[0] as any[];
    expect(select.text).toBe("🟢 Model 9 ✓");
    expect(favorite.text).toBe("☆");
    expect(resolveModelCenterAction(select.callback_data.slice("mc:select:".length))?.modelID).toBe("model-9");
    expect(view.keyboard.inline_keyboard.flat().filter((b) => b.text.includes("Colors"))).toHaveLength(1);
  });
  it("pins pages/favorites while reopening picks up refreshed evidence", async () => {
    state.enabled = true;
    const first = await buildModelCenterProvider(provider, 0);
    const next = first.keyboard.inline_keyboard.flat().find((b) => b.text === "Next ›") as any;
    const id = next.callback_data.split(":")[2];
    const favorite = first.keyboard.inline_keyboard[0][1] as any;
    expect(resolveModelCenterFavoriteTarget(favorite.callback_data.slice("mc:favorite:".length))).toMatchObject({ viewID: id });
    state.prices = new Map([["model-0", { group: "free" }], ["model-9", { group: "paid" }]]);
    state.models.reverse();
    const second = await buildModelCenterProvider(provider, 1, undefined, id);
    expect(second.keyboard.inline_keyboard[1][0].text).toBe("🔴 Model 0");
    expect((await buildModelCenterProvider(provider, 0)).keyboard.inline_keyboard[0][0].text).toBe("🟢 Model 0");
  });
  it("bounds callback bytes even with long provider identifiers", async () => {
    state.enabled = true;
    const view = await buildModelCenterProvider({ ...provider, id: "long-provider-".repeat(8) }, 0);
    for (const button of view.keyboard.inline_keyboard.flat() as any[]) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  });
  it("rejects expired/foreign views and changed credentials", async () => {
    state.enabled = true;
    const view = (await getProviderPriceView("p", state.models))!;
    await expect(getProviderPriceView("other", state.models, view.id)).rejects.toThrow("Reopen");
    state.revision = "changed-key";
    await expect(getProviderPriceView("p", state.models, view.id)).rejects.toThrow("Reopen");
    state.revision = "a";
    vi.useFakeTimers(); vi.advanceTimersByTime(900_001);
    await expect(getProviderPriceView("p", state.models, view.id)).rejects.toThrow("Reopen");
  });
  it("discards work finishing after the feature is disabled", async () => {
    state.enabled = true;
    let finish!: (prices: Map<string, any>) => void;
    vi.mocked(getProviderModelPrices).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const creating = getProviderPriceView("p", state.models);
    await Promise.resolve(); await Promise.resolve();
    state.enabled = false; clearProviderPriceViews();
    finish(new Map());
    expect(await creating).toBeUndefined();
  });
});
