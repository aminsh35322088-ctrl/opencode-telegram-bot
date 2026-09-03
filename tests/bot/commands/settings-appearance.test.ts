import { describe, expect, it } from "vitest";
import {
  buildAppearanceSettingsView,
  SETTINGS_ASSISTANT_FOOTER_CALLBACK,
  SETTINGS_BACK_CALLBACK,
  SETTINGS_COMPACT_OUTPUT_CALLBACK,
  SETTINGS_DIFF_FILES_CALLBACK,
  SETTINGS_RESPONSE_STREAMING_CALLBACK,
  SETTINGS_THINKING_CONTENT_CALLBACK,
} from "../../../src/bot/menus/settings-menu.js";

function getButtons() {
  return buildAppearanceSettingsView().keyboard.inline_keyboard.flatMap((row) => row);
}

describe("appearance settings UI", () => {
  it("exposes every appearance control with a matching callback", () => {
    const callbacks = getButtons().map((button) => button.callback_data);

    expect(callbacks).toContain(SETTINGS_COMPACT_OUTPUT_CALLBACK);
    expect(callbacks).toContain(SETTINGS_THINKING_CONTENT_CALLBACK);
    expect(callbacks).toContain(SETTINGS_RESPONSE_STREAMING_CALLBACK);
    expect(callbacks).toContain(SETTINGS_ASSISTANT_FOOTER_CALLBACK);
    expect(callbacks).toContain(SETTINGS_DIFF_FILES_CALLBACK);
    expect(callbacks).toContain(SETTINGS_BACK_CALLBACK);
  });

  it("describes every visible appearance control", () => {
    const text = buildAppearanceSettingsView().text;

    expect(text).toContain("Compact output");
    expect(text).toContain("Thinking details");
    expect(text).toContain("Reply streaming");
    expect(text).toContain("Run footer");
    expect(text).toContain("Diff files");
  });
});
