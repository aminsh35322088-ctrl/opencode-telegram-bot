import assert from "node:assert/strict";
import { test } from "node:test";

test("shared model routing formatter includes reasoning and every Topic capability line", async () => {
  const module = await import("../src/app/services/model-routing-summary-service.js");
  const format = (module as unknown as { formatModelRoutingSummary?: Function }).formatModelRoutingSummary;
  assert.equal(typeof format, "function");
  const capabilities = {
    modalities: { input: { text: true, image: true, audio: false, video: false, pdf: false }, output: { text: true, image: false, audio: false, video: false, pdf: false } },
    operations: { chat: true, imageGenerate: false, imageEdit: false, speechToText: false, textToSpeech: false, videoGenerate: false, embeddings: false },
    agent: { toolCalling: true, reasoning: true, structuredOutput: true },
    traits: { codingOptimized: true },
  };
  const catalog = [{
    providerID: "p", providerName: "Provider", modelID: "m", modelName: "Model",
    capabilities, capabilityDetection: { source: "provider-metadata", confidence: "high" }, availability: "available",
  }];
  const route = (capability: string) => ({ capability, model: { providerID: "p", modelID: "m" }, routeSource: "primary-native", primarySupportsCapability: true });
  const routes = new Map(["vision", "voiceInput", "imageGenerate", "textToSpeech"].map((capability) => [capability, route(capability)]));
  const text = format!({ providerID: "p", modelID: "m", name: "Model" }, catalog, routes);
  assert.match(text, /🧠 Active Model: Model · Provider/);
  for (const line of [
    "✅ Chat / Text → Model · Provider · Primary native",
    "✅ Vision → Model · Provider · Primary native",
    "🧠 Reasoning ✅ · Primary model",
    "📥 Input modalities: text, image",
    "📤 Output modalities: text",
    "🎬 Video AI generation ❌ · Primary model metadata",
    "🧮 Embeddings ❌",
    "🧾 Structured Output ✅",
    "💻 Coding Optimized ✅",
    "✅ Voice → Text → Model · Provider · Primary native",
    "✅ Image AI → Model · Provider · Primary native",
    "✅ Text → Voice → Model · Provider · Primary native",
    "🛠️ Tool Calling ✅ · Primary model",
    "🤖 Agent Mode ✅",
    "✅ Primary native  ⚙️ Topic Override  ↪️ Main Default  ❌ Unavailable  ❔ Unconfirmed",
  ]) assert.ok(text.includes(line), `missing ${line}`);
});
