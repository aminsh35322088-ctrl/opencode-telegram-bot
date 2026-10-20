import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  buildSummary: vi.fn(),
  refreshProviders: vi.fn(),
}));

vi.mock("../../../src/app/services/model-preferences-service.js", () => ({
  getFavoriteModels: vi.fn().mockResolvedValue([]),
  getRecentModels: vi.fn().mockResolvedValue([]),
  recordRecentModel: vi.fn(),
}));
vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  fetchCurrentModel: vi.fn(),
  getProviderModels: vi.fn().mockResolvedValue([]),
  getProviders: vi.fn().mockResolvedValue([]),
  selectModel: vi.fn(),
}));
vi.mock("../../../src/app/services/model-catalog-refresh-service.js", () => ({
  refreshAllCustomProviderModels: mocked.refreshProviders,
}));
vi.mock("../../../src/app/services/model-capabilities-service.js", () => ({
  getModelCapabilities: vi.fn().mockResolvedValue(null),
  formatCapabilitiesIcons: vi.fn().mockReturnValue("💬 Chat · 👁️ Vision"),
}));
vi.mock("../../../src/app/services/model-routing-summary-service.js", () => ({
  buildModelRoutingSummary: mocked.buildSummary,
}));
vi.mock("../../../src/app/services/provider-price-view.js", () => ({
  getProviderPriceView: vi.fn(),
}));
vi.mock("../../../src/app/services/model-price-classifier.js", () => ({
  PRICE_COLOR: { unknown: "⚪" },
}));
vi.mock("../../../src/bot/menus/inline-menu.js", () => ({ replyWithInlineMenu: vi.fn() }));
vi.mock("../../../src/utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildModelCenterRoot } from "../../../src/bot/menus/model-center-menu.js";

describe("Model Center full capability routing details", () => {
  it("shows route targets and configuration source in the selected model panel", async () => {
    const current = { providerID: "coding", modelID: "coder", name: "Coding Model" };
    mocked.buildSummary.mockResolvedValue(
      [
        "🧠 Active Model: Coding Model · Coding Provider",
        "",
        "✅ Chat / Text → Coding Model · Coding Provider · Primary native",
        "✅ Vision → Vision Pro · Vision Provider · Primary native",
        "↪️ Voice → Text → Whisper · Voice Provider · Main Default",
        "⚙️ Image AI → Image Maker · Image Provider · Topic Override",
        "❌ Text → Voice → Unavailable",
        "🛠️ Tool Calling ❌ · Primary model",
      ].join("\n"),
    );

    const view = await buildModelCenterRoot(current, {
      favorites: async () => [],
      recent: async () => [],
      providers: async () => [],
      models: async () => [],
      capabilityIcons: async () => "💬 Chat · 👁️ Vision",
    });

    expect(view.text).toContain("<b>CAPABILITIES &amp; ROUTING</b>");
    expect(view.text).toContain(
      "<pre>✅ Chat / Text → Coding Model · Coding Provider · Primary native",
    );
    expect(view.text).toContain("↪️ Voice → Text → Whisper · Voice Provider · Main Default");
    expect(view.text).toContain("⚙️ Image AI → Image Maker · Image Provider · Topic Override");
    expect(view.text).toContain("❌ Text → Voice → Unavailable");
    expect(view.text).toContain("</pre>");
    expect(mocked.buildSummary).toHaveBeenCalledWith(current);
  });

  it("keeps Model Center available if capability discovery fails", async () => {
    mocked.buildSummary.mockRejectedValueOnce(new Error("catalog unavailable"));
    const view = await buildModelCenterRoot(
      { providerID: "coding", modelID: "coder", name: "Coding Model" },
      {
        favorites: async () => [],
        recent: async () => [],
        providers: async () => [],
        models: async () => [],
        capabilityIcons: async () => "",
      },
    );
    expect(view.text).toContain("<b>CURRENT MODEL</b>");
    expect(view.text).not.toContain("CAPABILITIES &amp; ROUTING");
  });
});
