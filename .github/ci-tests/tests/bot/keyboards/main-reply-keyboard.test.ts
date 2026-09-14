import { describe, expect, it } from "vitest";
import { createAgentKeyboard, createMainKeyboard } from "../../../src/bot/keyboards/main-reply-keyboard.js";
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
      [{ text: "💬 New Chat" }, { text: "🎨 New Image Chat" }],
      [{ text: "🕘 History" }],
      [{ text: "🧠 GPT 4o" }],
      [{ text: "⚙️ Main Settings" }],
    ]);
    expect(keyboard.resize_keyboard).toBe(true);
    expect(keyboard.is_persistent).toBeUndefined();
  });

  it("prefers the advertised model name and keeps it single-line", () => {
    const keyboard = createMainKeyboard({
      providerID: "very-long-provider-name-that-keeps-going-and-going",
      modelID: "vendor/very-long-model-name-that-keeps-going-and-going",
      name: "Custom Model 2026",
    });

    const label = buttonTextAt(keyboard, 2, 0);
    expect(label).toBe("🧠 Custom Model 2026");
    expect(label).not.toContain("very-long-provider-name");
    expect(label).not.toContain(" · ");
    expect(label).not.toContain("\n");
  });

  it("reflects compact mode state in an AI Topic", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { compactOutputMode: true, isTopic: true },
    );
    expect(buttonTextAt(keyboard, 0, 1)).toBe("📦 Compact: ON");
  });

  it("keeps queued prompts above the fixed idle grid", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { queuedPromptLabels: ["❌ 1. first", "❌ 2. second"] },
    );
    expect(buttonTextAt(keyboard, 0, 0)).toBe("❌ 1. first");
    expect(buttonTextAt(keyboard, 1, 0)).toBe("❌ 2. second");
    expect(buttonTextAt(keyboard, 2, 0)).toBe("💬 New Chat");
    expect(buttonTextAt(keyboard, 2, 1)).toBe("🎨 New Image Chat");
    expect(buttonTextAt(keyboard, 4, 0)).toBe("🧠 GPT 4o");
    expect(buttonTextAt(keyboard, 5, 0)).toBe("⚙️ Main Settings");
  });

  it("keeps running controls isolated from idle controls", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { running: true, paused: false, compactOutputMode: true, isTopic: true },
    );
    expect(keyboard.keyboard.filter((row) => row.length > 0)).toEqual([
      [{ text: "⏸️ Pause" }, { text: "🛑 Abort" }],
      [{ text: "🗑️ Delete Chat" }, { text: "📦 Compact: ON" }],
      [{ text: "🧠 GPT 4o" }, { text: "⚙️ Topic Settings" }],
    ]);
  });

  it("keeps image creation out of coding Topic controls", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { compactOutputMode: false, isTopic: true },
    );
    expect(keyboard.keyboard.flat().map(getButtonText)).not.toContain("🎨 Image AI");
  });

  it("creates a custom agent keyboard", () => {
    const keyboard = createAgentKeyboard("custom");
    expect(keyboard.keyboard.filter((row) => row.length > 0)).toEqual([[{ text: "🤖 Custom Agent" }]]);
    expect(keyboard.resize_keyboard).toBe(true);
    expect(keyboard.is_persistent).toBeUndefined();
  });
});
