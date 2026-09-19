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
  it("creates a compact main keyboard without model controls", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { compactOutputMode: false },
    );

    expect(keyboard.keyboard.filter((row) => row.length > 0)).toEqual([
      [{ text: "💬 New Chat" }],
      [{ text: "🕘 History" }, { text: "⚙️ Main Settings" }],
    ]);
    expect(keyboard.keyboard.flat().map(getButtonText)).not.toContain("🧠 GPT 4o");
    expect(keyboard.resize_keyboard).toBe(true);
    expect(keyboard.is_persistent).toBeUndefined();
  });

  it("shows the unified Models hub only inside an AI Topic", () => {
    const keyboard = createMainKeyboard({
      providerID: "very-long-provider-name-that-keeps-going-and-going",
      modelID: "vendor/very-long-model-name-that-keeps-going-and-going",
      name: "Custom Model 2026",
    }, { isTopic: true });

    const labels = keyboard.keyboard.flat().map(getButtonText);
    expect(labels).toContain("🧠 Custom Model 2026");
    expect(labels.join("\n")).not.toContain("very-long-provider-name");
    expect(labels.join("\n")).not.toContain(" · ");
    expect(keyboard.is_persistent).toBe(true);
  });

  it("reflects compact mode state in an AI Topic", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { compactOutputMode: true, isTopic: true },
    );
    expect(buttonTextAt(keyboard, 0, 0)).toBe("📦 Compact: ON");
  });

  it("keeps queued prompts above the fixed main grid", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { queuedPromptLabels: ["❌ 1. first", "❌ 2. second"] },
    );
    expect(buttonTextAt(keyboard, 0, 0)).toBe("❌ 1. first");
    expect(buttonTextAt(keyboard, 1, 0)).toBe("❌ 2. second");
    expect(buttonTextAt(keyboard, 2, 0)).toBe("💬 New Chat");
    expect(buttonTextAt(keyboard, 3, 0)).toBe("🕘 History");
    expect(buttonTextAt(keyboard, 3, 1)).toBe("⚙️ Main Settings");
  });

  it("keeps running controls isolated inside the Topic keyboard", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { running: true, paused: false, compactOutputMode: true, isTopic: true },
    );
    expect(keyboard.keyboard.filter((row) => row.length > 0)).toEqual([
      [{ text: "⏸️ Pause" }, { text: "🛑 Abort" }],
      [{ text: "📦 Compact: ON" }],
      [{ text: "🧠 GPT 4o" }],
      [{ text: "🗑️ Delete Chat" }, { text: "⚙️ Topic Settings" }],
    ]);
  });

  it("keeps Main navigation out of coding Topic controls", () => {
    const keyboard = createMainKeyboard(
      { providerID: "openrouter", modelID: "openai/gpt-4o" },
      { compactOutputMode: false, isTopic: true },
    );
    const labels = keyboard.keyboard.flat().map(getButtonText);
    expect(labels).not.toContain("🎨 Image AI");
    expect(labels).not.toContain("💬 New Chat");
    expect(labels).not.toContain("🕘 History");
    expect(labels).not.toContain("⚙️ Main Settings");
  });

  it("creates a custom agent keyboard", () => {
    const keyboard = createAgentKeyboard("custom");
    expect(keyboard.keyboard.filter((row) => row.length > 0)).toEqual([[{ text: "🤖 Custom Agent" }]]);
    expect(keyboard.resize_keyboard).toBe(true);
    expect(keyboard.is_persistent).toBeUndefined();
  });
});
