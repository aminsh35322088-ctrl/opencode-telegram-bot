[Reading 108 lines from start (total: 108 lines, 0 remaining)]

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCapabilityRoute: vi.fn(),
  saveTopicVoiceAsset: vi.fn(),
  editBotText: vi.fn(),
  findUnifiedModel: vi.fn(),
  prepareNativeAudioInput: vi.fn(),
  sanitizeAudioHistoryForTextFallback: vi.fn(),
  getEffectiveCurrentSession: vi.fn(),
}));
vi.mock("../../../src/app/services/model-capability-routing-service.js", () => ({ resolveCapabilityRoute: mocks.resolveCapabilityRoute }));
vi.mock("../../../src/app/services/telegram-topic-voice-asset-service.js", () => ({ saveTopicVoiceAsset: mocks.saveTopicVoiceAsset }));
vi.mock("../../../src/bot/messages/telegram-text.js", () => ({ editBotText: mocks.editBotText }));
vi.mock("../../../src/app/services/unified-model-catalog-service.js", () => ({ findUnifiedModel: mocks.findUnifiedModel }));
vi.mock("../../../src/app/services/native-audio-input-service.js", () => ({ prepareNativeAudioInput: mocks.prepareNativeAudioInput }));
vi.mock("../../../src/app/services/session-error-recovery-service.js", () => ({ sanitizeAudioHistoryForTextFallback: mocks.sanitizeAudioHistoryForTextFallback }));
vi.mock("../../../src/app/services/session-service.js", () => ({ getEffectiveCurrentSession: mocks.getEffectiveCurrentSession }));

import { handleVoiceMessage } from "../../../src/bot/handlers/voice-handler.js";

function ctx() {
  return {
    chat: { id: 123 },
    message: { voice: { file_id: "voice-1", mime_type: "audio/ogg" } },
    reply: vi.fn().mockResolvedValue({ message_id: 77 }),
    api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
  } as any;
}

describe("voice capability routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveTopicVoiceAsset.mockResolvedValue(null);
    mocks.editBotText.mockResolvedValue(undefined);
    mocks.getEffectiveCurrentSession.mockResolvedValue({ id: "session-1", title: "Topic", directory: "/repo" });
    mocks.sanitizeAudioHistoryForTextFallback.mockResolvedValue({ removedMessageIds: [], contaminationRemaining: false });
    mocks.findUnifiedModel.mockResolvedValue({
      providerID: "native",
      modelID: "audio",
      execution: { nativeAudioFileInput: true, nativeAudioMimeTypes: ["audio/wav"] },
    });
  });

  it("sends audio directly only after the native transport prepares a verified media type", async () => {
    mocks.resolveCapabilityRoute.mockResolvedValue({ capability: "voiceInput", routeSource: "primary-native", primarySupportsCapability: true, model: { providerID: "native", modelID: "audio" } });
    mocks.prepareNativeAudioInput.mockResolvedValue({ buffer: Buffer.from("wav"), filename: "audio.wav", mimeType: "audio/wav", transcoded: true });
    const transcribeAudio = vi.fn();
    const processPrompt = vi.fn().mockResolvedValue(true);
    await handleVoiceMessage(ctx(), {
      bot: {} as any,
      ensureEventSubscription: vi.fn(),
      isSttConfigured: vi.fn().mockResolvedValue(false),
      downloadTelegramFile: vi.fn().mockResolvedValue({ buffer: Buffer.from("audio"), filename: "voice.ogg" }),
      transcribeAudio,
      processPrompt,
    });
    expect(mocks.prepareNativeAudioInput).toHaveBeenCalledWith(expect.any(Buffer), "voice.ogg", "audio/ogg", expect.objectContaining({ nativeAudioFileInput: true }));
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(processPrompt).toHaveBeenCalledTimes(1);
    expect(processPrompt.mock.calls[0]?.[3]).toHaveLength(1);
    expect(processPrompt.mock.calls[0]?.[3]?.[0]?.mime).toBe("audio/wav");
  });

  it("falls back to the configured STT helper instead of sending an unsupported native FilePart", async () => {
    const native = { providerID: "primary", modelID: "audio-model" };
    const helper = { providerID: "groq", modelID: "whisper-large-v3" };
    mocks.resolveCapabilityRoute
      .mockResolvedValueOnce({ capability: "voiceInput", routeSource: "primary-native", primarySupportsCapability: true, model: native })
      .mockResolvedValueOnce({ capability: "voiceInput", routeSource: "main-default", primarySupportsCapability: true, model: helper });
    mocks.prepareNativeAudioInput.mockResolvedValue(null);
    const transcribeAudio = vi.fn().mockResolvedValue({ text: "سلام دنیا", uncertain: false });
    const processPrompt = vi.fn().mockResolvedValue(true);

    await handleVoiceMessage(ctx(), {
      bot: {} as any,
      ensureEventSubscription: vi.fn(),
      isSttConfigured: vi.fn().mockResolvedValue(true),
      downloadTelegramFile: vi.fn().mockResolvedValue({ buffer: Buffer.from("audio"), filename: "voice.ogg" }),
      transcribeAudio,
      processPrompt,
    });

    expect(mocks.resolveCapabilityRoute).toHaveBeenNthCalledWith(2, "voiceInput", undefined, { allowPrimaryNative: false });
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), "voice.ogg", helper);
    expect(mocks.sanitizeAudioHistoryForTextFallback).toHaveBeenCalledWith("session-1", "/repo");
    expect(processPrompt).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("سلام دنیا"), expect.anything(), []);
    expect(processPrompt.mock.calls[0]?.[3]).toEqual([]);
  });

  it("forces the selected Topic STT override even when Primary audio exists", async () => {
    const selected = { providerID: "groq", modelID: "whisper-large-v3" };
    mocks.resolveCapabilityRoute.mockResolvedValue({ capability: "voiceInput", routeSource: "topic-override", primarySupportsCapability: true, model: selected });
    const transcribeAudio = vi.fn().mockResolvedValue({ text: "سلام دنیا", uncertain: false });
    const processPrompt = vi.fn().mockResolvedValue(true);
    await handleVoiceMessage(ctx(), {
      bot: {} as any,
      ensureEventSubscription: vi.fn(),
      isSttConfigured: vi.fn().mockResolvedValue(true),
      downloadTelegramFile: vi.fn().mockResolvedValue({ buffer: Buffer.from("audio"), filename: "voice.ogg" }),
      transcribeAudio,
      processPrompt,
    });
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Buffer), "voice.ogg", selected);
    expect(mocks.sanitizeAudioHistoryForTextFallback).toHaveBeenCalledWith("session-1", "/repo");
    expect(processPrompt).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("سلام دنیا"), expect.anything(), []);
  });
});