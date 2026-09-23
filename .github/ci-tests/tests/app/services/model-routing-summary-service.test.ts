import { describe, expect, it, vi } from "vitest";

const resolveCapabilityPlan = vi.hoisted(() => vi.fn());
vi.mock("../../../src/app/services/model-capability-routing-service.js", () => ({ resolveCapabilityPlan }));

import { buildModelRoutingSummary } from "../../../src/app/services/model-routing-summary-service.js";

describe("model routing summary", () => {
  it("renders a compact capability card without repeating model/provider on every row", async () => {
    resolveCapabilityPlan.mockResolvedValue({
      catalog: [{
        providerID: "opencode",
        providerName: "OpenCode Zen",
        modelID: "muse",
        modelName: "Muse Spark 1.2 Free",
        availability: "available",
        capabilities: { operations: { chat: true }, agent: { toolCalling: false } },
      }],
      routes: new Map([
        ["vision", { routeSource: "primary-native" }],
        ["voiceInput", { routeSource: "unavailable" }],
        ["imageGenerate", { routeSource: "main-default" }],
        ["textToSpeech", { routeSource: "topic-override" }],
      ]),
    });

    const text = await buildModelRoutingSummary({ providerID: "opencode", modelID: "muse" }, "/repo");
    expect(text).toBe([
      "🧠 Muse Spark 1.2 Free · OpenCode Zen",
      "",
      "💬 Chat ✅",
      "👁️ Vision ✅",
      "🎙️ Voice → Text ❌",
      "🎨 Image AI ↪️",
      "🔊 Text → Voice ✅ ⚙️",
      "🛠️ Tool Call ❌",
      "🤖 Agent Mode ❌",
    ].join("\n"));
    expect(text).not.toContain("Active Model:");
    expect(text).not.toContain("Native  ⚙️");
    expect((text.match(/OpenCode Zen/g) ?? [])).toHaveLength(1);
  });
});
