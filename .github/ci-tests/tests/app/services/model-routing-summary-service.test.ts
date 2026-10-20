import { describe, expect, it } from "vitest";
import { formatModelRoutingSummary } from "../../../src/app/services/model-routing-summary-formatter.js";

describe("model routing summary", () => {
  it("renders detailed model capability and helper routing information", async () => {
    const catalog = [
      {
        providerID: "opencode",
        providerName: "OpenCode Zen",
        modelID: "muse",
        modelName: "Muse Spark 1.2 Free",
        availability: "available",
        capabilities: {
          operations: { chat: true },
          agent: { toolCalling: false, reasoning: true },
        },
      },
      {
        providerID: "vision-provider",
        providerName: "Vision Co",
        modelID: "vision-model",
        modelName: "Vision Model",
        availability: "available",
        capabilities: { operations: {}, agent: {} },
      },
      {
        providerID: "voice-provider",
        providerName: "Voice Co",
        modelID: "whisper",
        modelName: "Whisper STT",
        availability: "available",
        capabilities: { operations: {}, agent: {} },
      },
      {
        providerID: "image-provider",
        providerName: "Image Co",
        modelID: "image-gen",
        modelName: "Image Gen",
        availability: "available",
        capabilities: { operations: {}, agent: {} },
      },
      {
        providerID: "tts-provider",
        providerName: "Speech Co",
        modelID: "speech",
        modelName: "Speech Output",
        availability: "available",
        capabilities: { operations: {}, agent: {} },
      },
    ];
    const routes = new Map([
      [
        "vision",
        {
          routeSource: "primary-native",
          model: { providerID: "vision-provider", modelID: "vision-model" },
        },
      ],
      [
        "voiceInput",
        {
          routeSource: "main-default",
          model: { providerID: "voice-provider", modelID: "whisper" },
        },
      ],
      [
        "imageGenerate",
        {
          routeSource: "main-default",
          model: { providerID: "image-provider", modelID: "image-gen" },
        },
      ],
      [
        "textToSpeech",
        { routeSource: "topic-override", model: { providerID: "tts-provider", modelID: "speech" } },
      ],
    ]);

    const text = formatModelRoutingSummary(
      { providerID: "opencode", modelID: "muse" },
      catalog as never,
      routes as never,
    );
    expect(text).toBe(
      [
        "🧠 Active Model: Muse Spark 1.2 Free · OpenCode Zen",
        "",
        "✅ Chat / Text → Muse Spark 1.2 Free · OpenCode Zen · Primary native",
        "✅ Vision → Vision Model · Vision Co · Primary native",
        "🧠 Reasoning ✅ · Primary model",
        "↪️ Voice → Text → Whisper STT · Voice Co · Main Default",
        "↪️ Image AI → Image Gen · Image Co · Main Default",
        "⚙️ Text → Voice → Speech Output · Speech Co · Topic Override",
        "🛠️ Tool Calling ❌ · Primary model",
        "🤖 Agent Mode ❌",
        "",
        "✅ Primary native  ⚙️ Topic Override  ↪️ Main Default  ❌ Unavailable  ❔ Unconfirmed",
      ].join("\n"),
    );
    expect(text).toContain("Whisper STT · Voice Co · Main Default");
    expect(text).toContain("Image Gen · Image Co · Main Default");
  });
});
