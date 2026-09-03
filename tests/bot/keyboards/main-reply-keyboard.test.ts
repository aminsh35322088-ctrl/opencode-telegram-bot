import { describe, expect, it } from "vitest";
import { createAgentKeyboard, createMainKeyboard, removeKeyboard } from "../../../src/bot/keyboards/main-reply-keyboard.js";
import { defined } from "../../helpers/defined.js";

function getButtonText(button: string | { text: string }): string {
  return typeof button === "string" ? button : button.text;
}

function buttonTextAt(
  keyboard: ReturnType<typeof createMainKeyboard>,
  row: number,
  col: number,
): string {
  return getButtonText(defined(keyboard.keyboard[row]?.[col], `button[${row}][${col}]`));
}

describe("bot/keyboards/main-reply-keyboard", () => {
  it("creates the idle main keyboard with a full-width model selector", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { compactOutputMode: false },
    );

    expect(keyboard.keyboard.filter((row) => row.length > 0)).toEqual([
      [{ text: "🕘 History" }, { text: "💬 New Chat" }],
      [{ text: "🎨 Image AI" }, { text: "📦 Compact: OFF" }],
      [{ text: "🧠 openai/gpt-4o · openrouter" }],
      [{ text: "⚙️ Settings" }],
    ]);
    expect(keyboard.resize_keyboard).toBe(true);
    expect(keyboard.is_persistent).toBe(true);
  });

  it("keeps long model and provider labels compact and single-line", () => {
    const keyboard = createMainKeyboard({
      providerID: "very-long-provider-name-that-keeps-going-and-going",
      modelID: "vendor/very-long-model-name-that-keeps-going-and-going",
    });

    const label = buttonTextAt(keyboard, 2, 0);
    expect(label).toContain("🧠 vendor/very-long-model-name");
    expect(label).toContain(" · very-long-provider-name");
    expect(label).not.toContain("\n");
    expect(label.length).toBeLessThanOrEqual(48);
    expect(label.endsWith("…")).toBe(true);
  });

  it("reflects compact mode state", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { compactOutputMode: true },
    );
    expect(buttonTextAt(keyboard, 1, 1)).toBe("📦 Compact: ON");
  });

  it("keeps queued prompts above the fixed idle grid", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { queuedPromptLabels: ["❌ 1. first", "❌ 2. second"] },
    );
    expect(buttonTextAt(keyboard, 0, 0)).toBe("❌ 1. first");
    expect(buttonTextAt(keyboard, 1, 0)).toBe("❌ 2. second");
    expect(buttonTextAt(keyboard, 2, 0)).toBe("🕘 History");
    expect(buttonTextAt(keyboard, 2, 1)).toBe("💬 New Chat");
    expect(buttonTextAt(keyboard, 3, 0)).toBe("🎨 Image AI");
    expect(buttonTextAt(keyboard, 3, 1)).toBe("📦 Compact: OFF");
    expect(buttonTextAt(keyboard, 4, 0)).toBe("🧠 openai/gpt-4o · openrouter");
    expect(buttonTextAt(keyboard, 5, 0)).toBe("⚙️ Settings");
  });

  it("keeps running controls isolated from idle controls", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { running: true, paused: false, compactOutputMode: true },
    );
    expect(keyboard.keyboard.filter((row) => row.length > 0)).toEqual([
      [{ text: "⏸️ Pause" }, { text: "🛑 Abort" }],
    ]);
  });

  it("creates custom agent keyboard and remove payload", () => {
    const keyboard = createAgentKeyboard("custom");
    expect(keyboard.keyboard.filter((row) => row.length > 0)).toEqual([[{ text: "🤖 Custom Agent" }]]);
    expect(keyboard.resize_keyboard).toBe(true);
    expect(keyboard.is_persistent).toBe(true);
    expect(removeKeyboard()).toEqual({ remove_keyboard: true });
  });
});
