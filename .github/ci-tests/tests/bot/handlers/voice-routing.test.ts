import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCapabilityRoute: vi.fn(),
  saveTopicVoiceAsset: vi.fn(),
  editBotText: vi.fn(),
}));
vi.mock("../../../src/app/services/model-capability-routing-service.js", () => ({ resolveCapabilityRoute: mocks.resolveCapabilityRoute }));
vi.mock("../../../src/app/services/telegram-topic-voice-asset-service.js", () => ({ saveTopicVoiceAsset: mocks.saveTopicVoiceAsset }));
vi.mock("../../../src/bot/messages/telegram-text.js", () => ({ editBotText: mocks.editBotText }));

import { handleVoiceMessage } from "../../../src/bot/handlers/voice-handler.js";

function ctx() {
  return {
    chat: { id: 123 },
    message: { voice: { file_id: "voice-1" } },
    reply: vi.fn().mockResolvedValue({ message_id: 77 }),
    api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
  } as any;
}

describe("voice capability routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveTopicVoiceAsset.mockResolvedValue(null);
    mocks.editBotText.mockResolvedValue(undefined);
  });

  it("sends audio directly to a native-audio Primary without STT", async () => {
    mocks.resolveCapabilityRoute.mockResolvedValue({ capability: "voiceInput", routeSource: "primary-native", primarySupportsCapability: true, model: { providerID: "gemini", modelID: "native-audio" } });
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
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(processPrompt).toHaveBeenCalledTimes(1);
    expect(processPrompt.mock.calls[0]?.[3]).toHaveLength(1);
    expect(processPrompt.mock.calls[0]?.[3]?.[0]?.mime).toBe("audio/ogg");
  });

  it("forces the selected Topic STT override even when Primary audio exists", async () => {
    const selected = { providerID: "groq", modelID: "whisper-large-v3" };
    mocks.resolveCapabilityRoute.mockResolvedValue({ capability: "voiceInput", routeSource: "topic-override", primarySupportsCapability: true, model: selected });
    const transcribeAudio = vi.fn().mockResolvedValue({ text: "سلام دنیا" });
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
    expect(processPrompt).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("سلام دنیا"), expect.anything(), []);
  });
});
