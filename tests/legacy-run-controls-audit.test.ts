import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { BOT_COMMANDS } from "../src/bot/commands/definitions.js";
import { createTopicKeyboard } from "../src/bot/keyboards/main-reply-keyboard.js";

const text = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Telegram exposes no legacy Pause Resume Abort or custom Stop product controls", () => {
  const commands = new Set(BOT_COMMANDS.map((item) => item.command));
  for (const command of ["pause", "resume", "abort", "stop"]) {
    assert.equal(commands.has(command), false, `legacy Telegram command remains: /${command}`);
  }

  const keyboard = createTopicKeyboard({
    compactOutputMode: false,
    currentModel: { providerID: "p", modelID: "m", name: "Model" },
  });
  const labels = JSON.stringify(keyboard.keyboard);
  for (const legacy of ["Pause", "Resume", "Abort"]) assert.equal(labels.includes(legacy), false);

  const commandRouter = text("src/bot/routers/command-router.ts");
  for (const legacy of ["abort", "stop", "pause", "resume"]) {
    assert.equal(commandRouter.includes(`bot.command("${legacy}"`), false, `legacy router remains: ${legacy}`);
  }

  const replyRouter = text("src/bot/routers/reply-keyboard-router.ts");
  const messageRouter = text("src/bot/routers/message-router.ts");
  const classifier = text("src/bot/interaction-classifier.ts");
  const messagePatterns = text("src/bot/message-patterns.ts");
  const cloudUi = text("src/cloudflare/bot-ui.ts");
  for (const source of [replyRouter, messageRouter, classifier, messagePatterns, cloudUi]) {
    assert.doesNotMatch(source, /MAIN_BUTTONS\.(?:pause|resume|abort)/);
  }
  assert.doesNotMatch(cloudUi, /\["pause",\s*"resume",\s*"abort",\s*"stop"\]/);
  assert.doesNotMatch(cloudUi, /name === "abort"|name === "pause"|name === "resume"/);
  assert.doesNotMatch(messagePatterns, /⏸(?:️)? Pause|▶(?:️)? Resume|🛑 Abort/);

  const topicDeleteUi = text("src/bot/services/telegram-topic-delete-handler.ts");
  const englishUi = text("src/i18n/en.ts");
  assert.doesNotMatch(topicDeleteUi, /\babort\b/i);
  assert.doesNotMatch(englishUi, /\babort\b/i);
});

test("dedicated legacy run-control modules are retired and an internal cancellation service exists", async () => {
  for (const path of [
    "src/bot/commands/pause-command.ts",
    "src/bot/commands/abort-command.ts",
    "src/app/managers/paused-session-manager.ts",
  ]) assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, `${path} still exists`);

  const cancellation = await import("../src/app/services/current-run-cancellation-service.js").catch(() => ({}));
  assert.equal(typeof (cancellation as { cancelCurrentRun?: unknown }).cancelCurrentRun, "function");
});

test("user-facing source no longer advertises slash abort pause resume or custom stop", () => {
  const sources = [
    text("src/bot/commands/definitions.ts"),
    text("src/bot/routers/command-router.ts"),
    text("src/bot/routers/reply-keyboard-router.ts"),
    text("src/bot/routers/message-router.ts"),
    text("src/cloudflare/bot-ui.ts"),
    text("src/app/managers/interaction-manager.ts"),
  ].join("\n");
  assert.doesNotMatch(sources, /\/(?:abort|pause|resume)\b/);
  assert.doesNotMatch(sources, /Alias for \/abort/);
});
