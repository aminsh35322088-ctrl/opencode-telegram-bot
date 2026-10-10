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
  assert.match(text, /🧠 Model · Provider/);
  for (const line of ["💬 Chat ✅", "👁️ Vision ✅", "🧠 Reasoning ✅", "🎙️ Voice → Text ✅", "🎨 Image AI ✅", "🔊 Text → Voice ✅", "🛠️ Tool Call ✅", "🤖 Agent Mode ✅"]) assert.ok(text.includes(line), `missing ${line}`);
});
