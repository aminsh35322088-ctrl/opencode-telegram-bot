import { describe, expect, it } from "vitest";
import { buildAppearanceSettingsView, buildNotificationsSettingsView, buildSettingsMenuView } from "../../../src/bot/menus/settings-menu.js";

describe("settings UI", () => {
  it("builds the current settings menu", () => {
    const view = buildSettingsMenuView();
    expect(view.text).toContain("Settings");
    expect(view.keyboard.inline_keyboard).toHaveLength(5);
  });

  it("exposes compact output in appearance settings", () => {
    const appearance = buildAppearanceSettingsView();
    expect(appearance.keyboard.inline_keyboard.flat().some((button) => button.text.includes("Compact output"))).toBe(true);
  });

  it("exposes prompt queue in notifications settings", () => {
    const notifications = buildNotificationsSettingsView();
    expect(notifications.keyboard.inline_keyboard.flat().some((button) => button.text.includes("Prompt queue"))).toBe(true);
  });
});
