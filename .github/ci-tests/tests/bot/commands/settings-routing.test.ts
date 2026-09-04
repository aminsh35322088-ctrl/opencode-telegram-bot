import { describe, expect, it } from "vitest";
import {
  buildAdvancedSettingsView,
  buildAppearanceSettingsView,
  buildContextSettingsView,
  buildNotificationsSettingsView,
  buildSettingsMenuView,
  SETTINGS_ADVANCED_CALLBACK,
  SETTINGS_APPEARANCE_CALLBACK,
  SETTINGS_BACK_CALLBACK,
  SETTINGS_CONTEXT_CALLBACK,
  SETTINGS_MODEL_CALLBACK,
  SETTINGS_NOTIFICATIONS_CALLBACK,
} from "../../../src/bot/menus/settings-menu.js";

describe("settings top-level routing contracts", () => {
  it("exposes a callback for every top-level Settings section", () => {
    const callbacks = buildSettingsMenuView().keyboard.inline_keyboard.flatMap((row) =>
      row.flatMap((button) =>
        "callback_data" in button && typeof button.callback_data === "string" ? [button.callback_data] : [],
      ),
    );

    expect(callbacks).toContain(SETTINGS_MODEL_CALLBACK);
    expect(callbacks).toContain(SETTINGS_APPEARANCE_CALLBACK);
    expect(callbacks).toContain(SETTINGS_NOTIFICATIONS_CALLBACK);
    expect(callbacks).toContain(SETTINGS_CONTEXT_CALLBACK);
    expect(callbacks).toContain(SETTINGS_ADVANCED_CALLBACK);
  });

  it("labels the model entry as model selection and not AI Rules", () => {
    const view = buildSettingsMenuView();
    const buttons = view.keyboard.inline_keyboard.flatMap((row) => row);
    const labels = buttons.flatMap((button) => "text" in button && typeof button.text === "string" ? [button.text] : []);

    expect(labels).toContain("🤖 Model selection");
    expect(labels).not.toContain("🧠 AI Rules");
    expect(view.text).not.toContain("AI Rules");
  });

  it("keeps Context read-only and gives every Settings subview a return path", () => {
    expect(buildContextSettingsView().keyboard.inline_keyboard.flat()).toHaveLength(1);
    for (const view of [buildAppearanceSettingsView(), buildNotificationsSettingsView(), buildAdvancedSettingsView()]) {
      const callbacks = view.keyboard.inline_keyboard.flatMap((row) =>
        row.flatMap((button) =>
          "callback_data" in button && typeof button.callback_data === "string" ? [button.callback_data] : [],
        ),
      );
      expect(callbacks).toContain(SETTINGS_BACK_CALLBACK);
    }
  });
});
