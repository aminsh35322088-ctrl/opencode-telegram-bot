import { describe, expect, it } from "vitest";
import {
  buildAdvancedSettingsView,
  buildAppearanceSettingsView,
  buildContextSettingsView,
  buildNotificationsSettingsView,
  buildSettingsMenuView,
  SETTINGS_ADVANCED_CALLBACK,
  SETTINGS_BACK_CALLBACK,
  SETTINGS_MODEL_CALLBACK,
  SETTINGS_TOPIC_DEFAULTS_CALLBACK,
} from "../../../src/bot/menus/settings-menu.js";

describe("settings top-level routing contracts", () => {
  it("exposes a callback for every top-level Main Settings section", () => {
    const callbacks = buildSettingsMenuView().keyboard.inline_keyboard.flatMap((row) =>
      row.flatMap((button) =>
        "callback_data" in button && typeof button.callback_data === "string" ? [button.callback_data] : [],
      ),
    );

    expect(callbacks).toContain(SETTINGS_MODEL_CALLBACK);
    expect(callbacks).toContain(SETTINGS_TOPIC_DEFAULTS_CALLBACK);
    expect(callbacks).toContain(SETTINGS_ADVANCED_CALLBACK);
  });

  it("routes the model entry to the model selection callback", () => {
    const view = buildSettingsMenuView();
    const buttons = view.keyboard.inline_keyboard.flatMap((row) => row);
    const modelButtons = buttons.flatMap((button) =>
      "callback_data" in button && button.callback_data === SETTINGS_MODEL_CALLBACK && "text" in button && typeof button.text === "string"
        ? [button.text]
        : [],
    );

    expect(modelButtons.length).toBeGreaterThan(0);
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
