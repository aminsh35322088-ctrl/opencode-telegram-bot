import { describe, expect, it } from "vitest";
import { createAgentKeyboard, createMainKeyboard, removeKeyboard } from "../../../src/bot/keyboards/main-reply-keyboard.js";
import { defined } from "../../helpers/defined.js";

function getButtonText(button: string | { text: string }): string { return typeof button === "string" ? button : button.text; }
function buttonTextAt(keyboard: ReturnType<typeof createMainKeyboard>, row: number, col: number): string { return getButtonText(defined(keyboard.keyboard[row]?.[col], `button[${row}][${col}]`)); }

describe("bot/keyboards/main-reply-keyboard", () => {
  it("creates the compact main keyboard", () => {
    const keyboard = createMainKeyboard("build", { providerID: "openrouter", modelID: "openai/gpt-4o" });
    expect(buttonTextAt(keyboard, 0, 0)).toBe("🧠 openrouter\nopenai/gpt-4o");
    expect(buttonTextAt(keyboard, 0, 1)).toBe("💬 New Chat");
    expect(buttonTextAt(keyboard, 1, 0)).toBe("🕘 History");
    expect(buttonTextAt(keyboard, 1, 1)).toBe("⚙️ Settings");
    expect(keyboard.resize_keyboard).toBe(true);
    expect(keyboard.is_persistent).toBe(true);
  });

  it("keeps queued prompts above the fixed 2x2 grid", () => {
    const keyboard = createMainKeyboard("build", { providerID: "openrouter", modelID: "openai/gpt-4o" }, undefined, undefined, ["❌ 1. first", "❌ 2. second"]);
    expect(buttonTextAt(keyboard, 0, 0)).toBe("❌ 1. first");
    expect(buttonTextAt(keyboard, 1, 0)).toBe("❌ 2. second");
    expect(buttonTextAt(keyboard, 2, 0)).toBe("🧠 openrouter\nopenai/gpt-4o");
    expect(buttonTextAt(keyboard, 2, 1)).toBe("💬 New Chat");
    expect(buttonTextAt(keyboard, 3, 0)).toBe("🕘 History");
    expect(buttonTextAt(keyboard, 3, 1)).toBe("⚙️ Settings");
  });

  it("creates custom agent keyboard and remove payload", () => {
    const keyboard = createAgentKeyboard("custom");
    expect(keyboard.keyboard.filter((row) => row.length > 0)).toEqual([[{ text: "🤖 Custom Agent" }]]);
    expect(keyboard.resize_keyboard).toBe(true);
    expect(keyboard.is_persistent).toBe(true);
    expect(removeKeyboard()).toEqual({ remove_keyboard: true });
  });
});
