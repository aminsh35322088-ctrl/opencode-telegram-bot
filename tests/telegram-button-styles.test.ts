import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildContextSettingsView,
  buildFactoryResetConfirmationView,
  buildFactoryResetFinalView,
  buildMemoryClearConfirmationView,
  buildResetHistoryConfirmationView,
} from "../src/bot/menus/settings-menu.js";

function firstButton(view: { keyboard: { inline_keyboard: Array<Array<{ style?: string; callback_data?: string }>> } }) {
  const button = view.keyboard.inline_keyboard[0]?.[0];
  assert.ok(button, "expected first keyboard button");
  return button;
}

test("Context Compact is primary while destructive confirmations are danger", () => {
  assert.equal(firstButton(buildContextSettingsView()).style, "primary");
  assert.equal(firstButton(buildMemoryClearConfirmationView()).style, "danger");
  assert.equal(firstButton(buildResetHistoryConfirmationView()).style, "danger");
  assert.equal(firstButton(buildFactoryResetConfirmationView()).style, "danger");
  assert.equal(firstButton(buildFactoryResetFinalView()).style, "danger");
});
