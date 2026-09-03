import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeMode } from "../../../src/runtime/mode.js";
import {
  __resetSettingsForTests,
  flushSettings,
  getCompactOutputMode,
  getPromptQueueEnabled,
  getResponseStreamingMode,
  getShowThinkingContent,
  loadSettings,
  setCompactOutputMode,
} from "../../../src/app/stores/settings-store.js";

describe("settings-store", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "opencode-settings-"));
    process.env.OPENCODE_TELEGRAM_HOME = tempHome;
    setRuntimeMode("installed");
    __resetSettingsForTests();
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    delete process.env.INITIAL_SETTINGS_PRESET;
    __resetSettingsForTests();
    await rm(tempHome, { recursive: true, force: true });
  });

  it("loads current defaults", async () => {
    await loadSettings();
    expect(getCompactOutputMode()).toBe(false);
    expect(getShowThinkingContent()).toBe(false);
    expect(getPromptQueueEnabled()).toBe(false);
    expect(getResponseStreamingMode()).toBe("edit");
  });

  it("loads persisted current settings", async () => {
    await writeFile(path.join(tempHome, "settings.json"), JSON.stringify({ compactOutputMode: true, promptQueueEnabled: true, responseStreamingMode: "draft", showThinkingContent: false }));
    await loadSettings();
    expect(getCompactOutputMode()).toBe(true);
    expect(getPromptQueueEnabled()).toBe(true);
    expect(getResponseStreamingMode()).toBe("draft");
    expect(getShowThinkingContent()).toBe(false);
  });

  it("persists compact mode", async () => {
    await loadSettings();
    setCompactOutputMode(true);
    await flushSettings();
    const settings = JSON.parse(await readFile(path.join(tempHome, "settings.json"), "utf8"));
    expect(settings.compactOutputMode).toBe(true);
  });

  it("recovers from a corrupted settings file using the backup", async () => {
    await writeFile(path.join(tempHome, "settings.json"), '{"compactOutputMode":');
    await writeFile(path.join(tempHome, "settings.json.bak"), JSON.stringify({ compactOutputMode: true }));
    await loadSettings();
    expect(getCompactOutputMode()).toBe(true);
  });
});
