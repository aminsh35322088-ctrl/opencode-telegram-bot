import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCanonicalAdvancedSettingsView,
  buildCanonicalAppearanceSettingsView,
  buildCanonicalMoreSettingsView,
  buildCanonicalPromptQueueSettingsView,
  buildCanonicalSettingsMenuView,
  buildCanonicalTopicDefaultsSettingsView,
  buildCanonicalTopicModelsSettingsView,
} from "../src/bot/menus/settings-menu.js";

const labels = (view: { keyboard: { inline_keyboard: Array<Array<{ text: string }>> } }) =>
  view.keyboard.inline_keyboard.flat().map((button) => button.text);

test("canonical Main Settings preserves the pre-Cloudflare hierarchy", () => {
  const view = buildCanonicalSettingsMenuView();
  assert.match(view.text, /⚙️ <b>Settings<\/b>/);
  assert.deepEqual(labels(view), [
    "🧠 Model Center",
    "🐙 GitHub",
    "🌐 Tailscale",
    "🧩 Extensions",
    "⚡ Actions",
    "⋯ More",
  ]);
  assert.deepEqual(labels(buildCanonicalMoreSettingsView()), [
    "🧩 Topic Defaults",
    "🧪 Experimental",
    "🧰 Advanced",
    "← Settings",
  ]);
  assert.deepEqual(labels(buildCanonicalAdvancedSettingsView()), [
    "🧩 Custom Commands",
    "💾 Persistent Memory",
    "🧹 Clear Conversation History",
    "☢️ Factory Reset",
    "← Back",
  ]);
});

test("canonical Topic Settings keeps legacy models/agent/variant/output/queue/context layout", () => {
  const state = {
    model: "opencode/big-pickle",
    agent: "build",
    variant: "high",
    imageModel: "image/provider",
    voiceModel: "voice/provider",
    compactOutputMode: false,
    showThinkingContent: true,
    responseStreamingMode: "edit" as const,
    messageFormatMode: "markdown" as const,
    showAssistantRunFooter: true,
    sendDiffFileAttachments: true,
    promptQueueEnabled: true,
  };
  const root = buildCanonicalSettingsMenuView(state);
  assert.match(root.text, /🧠 <b>Model Center<\/b> · Capability-aware routing/);
  assert.equal(labels(root).includes("🧭 Session"), false);
  assert.deepEqual(labels(root), [
    "🧠 Models",
    "🧑‍💻 Agent · build",
    "🎛 Variant · high",
    "💬 Response & Output",
    "📥 Prompt Queue · ON",
    "🧠 Context Health",
    "✖ Close",
  ]);

  const models = buildCanonicalTopicModelsSettingsView(state);
  assert.deepEqual(labels(models), [
    "💬 Primary / Chat & Coding",
    "🎨 Image AI",
    "🎙️ Voice → Text",
    "← Topic Settings",
  ]);
  assert.match(models.text, /image\/provider/);
  assert.match(models.text, /voice\/provider/);
});

test("canonical output/default menus preserve old labels and navigation", () => {
  const state = {
    compactOutputMode: false,
    showThinkingContent: true,
    responseStreamingMode: "edit" as const,
    messageFormatMode: "markdown" as const,
    showAssistantRunFooter: true,
    sendDiffFileAttachments: true,
    promptQueueEnabled: true,
  };
  assert.deepEqual(labels(buildCanonicalAppearanceSettingsView(state)), [
    "📦 Compact output: OFF",
    "🧠 Thinking details: ON",
    "✍️ Reply streaming · Live edit",
    "📝 Message format · Markdown",
    "📊 Run footer: ON",
    "📎 Diff files: ON",
    "← Back",
  ]);
  assert.deepEqual(labels(buildCanonicalPromptQueueSettingsView(true)), ["📥 Prompt queue: ON", "← Back"]);
  assert.equal(labels(buildCanonicalTopicDefaultsSettingsView(state)).at(-1), "← Back");
});
