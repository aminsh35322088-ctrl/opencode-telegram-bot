import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getDefaultCapabilityModel: vi.fn(() => null),
  getDefaultImageModel: vi.fn(() => null),
  getFreeModelDetectionEnabled: vi.fn(() => false),
  getFreeModelSourcesEnabled: vi.fn(() => false),
  getCompactOutputMode: vi.fn(() => false),
  getCurrentTopicCapabilityOverride: vi.fn(() => null),
  getCurrentTopicImageModelOverride: vi.fn(() => null),
  getCurrentTopicSettings: vi.fn(() => null),
  getMessageFormatMode: vi.fn(() => "markdown"),
  getPromptQueueEnabled: vi.fn(() => true),
  getResponseStreamingMode: vi.fn(() => "edit"),
  getSendDiffFileAttachments: vi.fn(() => false),
  getShowAssistantRunFooter: vi.fn(() => true),
  getShowThinkingContent: vi.fn(() => false),
  getTopicDefaults: vi.fn(() => ({
    compactOutputMode: false,
    showThinkingContent: false,
    responseStreamingMode: "edit",
    messageFormatMode: "markdown",
    showAssistantRunFooter: true,
    sendDiffFileAttachments: false,
    promptQueueEnabled: true,
  })),
}));

vi.mock("../../../src/bot/keyboards/keyboard-manager.js", () => ({
  keyboardManager: {},
}));

import { buildSettingsMenuView } from "../../../src/bot/menus/settings-menu.js";

describe("core integration placement", () => {
  it("places Tailscale beside GitHub in top-level Settings", () => {
    const view = buildSettingsMenuView();
    const rows = view.keyboard.inline_keyboard;

    const integrationRow = rows.find((row) =>
      row.some((button) => button.callback_data === "settings:github"),
    );
    expect(integrationRow?.map((button) => button.callback_data)).toEqual([
      "settings:github",
      "integration:tailscale",
    ]);
    expect(view.text).toContain("GitHub · 🌐 Tailscale");
  });
});
