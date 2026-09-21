import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "grammy";

const mocks = vi.hoisted(() => ({
  discoverModels: vi.fn(),
  listCustomProviders: vi.fn(),
  saveCustomProvider: vi.fn(),
  isGroqSttConfigured: vi.fn(),
  listImageAiProviders: vi.fn(),
}));

vi.mock("../../../src/app/services/custom-provider-service.js", () => ({
  configureGroqStt: vi.fn(),
  deleteCustomProvider: vi.fn(),
  discoverModels: mocks.discoverModels,
  isGroqSttConfigured: mocks.isGroqSttConfigured,
  removeGroqStt: vi.fn(),
  listCustomProviders: mocks.listCustomProviders,
  saveCustomProvider: mocks.saveCustomProvider,
  syncOpenCodeCustomConfig: vi.fn().mockResolvedValue("/tmp/opencode.json"),
}));

vi.mock("../../../src/app/services/image-ai-provider-service.js", () => ({
  configureCloudflareCredentials: vi.fn(),
  configureImageAiProvider: vi.fn(),
  IMAGE_AI_PROVIDER_IDS: { CLOUDFLARE_ID: "cloudflare", CUSTOM_ID: "custom" },
  listImageAiProviders: mocks.listImageAiProviders,
  removeCloudflareCredentials: vi.fn(),
  removeImageAiProvider: vi.fn(),
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  reconcileStoredModelSelection: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({
  config: { opencode: { apiUrl: "http://127.0.0.1:4096" } },
}));

vi.mock("../../../src/opencode/process.js", () => ({
  findServerPid: vi.fn(),
  killServerProcess: vi.fn(),
  resolveLocalOpencodeTarget: vi.fn(() => null),
  startLocalOpencodeServer: vi.fn(),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/bot/commands/integrations-command.js", () => ({
  clearIntegrationWizard: vi.fn(),
}));

vi.mock("../../../src/bot/menus/settings-menu.js", () => ({
  buildSettingsMenuView: vi.fn(() => ({ text: "Settings", keyboard: {} })),
}));

vi.mock("../../../src/bot/menus/inline-menu.js", () => ({
  appendHomeNavigation: (keyboard: unknown) => keyboard,
}));

vi.mock("../../../src/app/services/ai-role-selection-service.js", () => ({
  setAiRoleSelection: vi.fn(),
}));

import {
  clearProviderWizard,
  handleProviderCallback,
  handleProviderWizardMessage,
  isProviderWizardActive,
} from "../../../src/bot/commands/providers-command.js";

function callbackContext(data: string, messageId = 500): Context {
  return {
    chat: { id: 777 },
    callbackQuery: { data, message: { message_id: messageId } } as Context["callbackQuery"],
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ message_id: 999 }),
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

function textContext(text: string, messageId: number): Context {
  return {
    chat: { id: 777 },
    message: { text, message_id: messageId } as Context["message"],
    reply: vi.fn().mockResolvedValue({ message_id: 999 }),
    api: {
      editMessageText: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  } as unknown as Context;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("provider wizard General panel contract", () => {
  beforeEach(() => {
    clearProviderWizard();
    mocks.discoverModels.mockReset();
    mocks.listCustomProviders.mockReset().mockResolvedValue([]);
    mocks.saveCustomProvider.mockReset().mockResolvedValue(undefined);
    mocks.isGroqSttConfigured.mockReset().mockResolvedValue(false);
    mocks.listImageAiProviders.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    clearProviderWizard();
    vi.useRealTimers();
  });

  it("renders expiry feedback on the original panel without replying", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T00:00:00Z"));

    const start = callbackContext("provider:add:stt", 500);
    expect(await handleProviderCallback(start)).toBe(true);
    expect(isProviderWizardActive()).toBe(true);

    vi.setSystemTime(new Date("2026-09-17T00:16:00Z"));
    const input = textContext("late input", 601);
    expect(await handleProviderWizardMessage(input)).toBe(true);

    expect(isProviderWizardActive()).toBe(false);
    expect(input.reply).not.toHaveBeenCalled();
    expect(input.api.deleteMessage).toHaveBeenCalledWith(777, 601);
    expect(input.api.editMessageText).toHaveBeenCalledWith(
      777,
      500,
      expect.stringContaining("Setup expired"),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
  });

  it("renders busy verification feedback on the original panel without replying", async () => {
    const start = callbackContext("provider:add:stt", 500);
    expect(await handleProviderCallback(start)).toBe(true);

    expect(await handleProviderWizardMessage(textContext("Example STT", 601))).toBe(true);
    expect(await handleProviderWizardMessage(textContext("https://api.example.com/v1", 602))).toBe(true);

    const discovery = deferred<Array<{ id: string }>>();
    mocks.discoverModels.mockReturnValueOnce(discovery.promise);
    const verification = handleProviderWizardMessage(textContext("secret-key", 603));
    await flushMicrotasks();

    const duplicate = textContext("another-key", 604);
    expect(await handleProviderWizardMessage(duplicate)).toBe(true);
    expect(duplicate.reply).not.toHaveBeenCalled();
    expect(duplicate.api.deleteMessage).toHaveBeenCalledWith(777, 604);
    expect(duplicate.api.editMessageText).toHaveBeenCalledWith(
      777,
      500,
      expect.stringContaining("Verification is already running"),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );

    discovery.resolve([{ id: "test-model" }]);
    await verification;
    expect(isProviderWizardActive()).toBe(false);
  });


  it("shows generic AI + transcription slots instead of separate chat/image provider slots", async () => {
    const ctx = callbackContext("provider:connections", 500);
    expect(await handleProviderCallback(ctx)).toBe(true);

    const keyboard = (ctx.api.editMessageText as any).mock.calls[0]?.[3]?.reply_markup;
    const callbacks = keyboard.inline_keyboard.flat().map((button: { callback_data?: string }) => button.callback_data);
    expect(callbacks).toContain("provider:slot:general");
    expect(callbacks).toContain("provider:slot:stt");
    expect(callbacks).not.toContain("provider:slot:coding");
    expect(callbacks).not.toContain("provider:slot:image");
  });

  it("migrates legacy add:image flow into one generic AI provider catalog", async () => {
    const start = callbackContext("provider:add:image", 500);
    expect(await handleProviderCallback(start)).toBe(true);

    expect(await handleProviderWizardMessage(textContext("Mixed API", 601))).toBe(true);
    expect(await handleProviderWizardMessage(textContext("https://api.example.com/v1", 602))).toBe(true);

    mocks.discoverModels.mockResolvedValueOnce([
      { id: "chat-model", modalities: { input: ["text"], output: ["text"] } },
      { id: "image-model", modalities: { input: ["text", "image"], output: ["image"] } },
    ]);

    expect(await handleProviderWizardMessage(textContext("secret-key", 603))).toBe(true);

    expect(mocks.saveCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
      name: "Mixed API",
      baseURL: "https://api.example.com/v1",
      capability: "general",
      models: expect.arrayContaining([
        expect.objectContaining({ id: "chat-model" }),
        expect.objectContaining({ id: "image-model" }),
      ]),
    }));
  });
});