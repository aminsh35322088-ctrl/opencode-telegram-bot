import { describe, expect, it } from "vitest";
import { AGENT_ACTIONS } from "../../../src/app/services/agent-action-registry.js";
import { getFriendlyActionDisplay, getFriendlyAgentActionDisplay } from "../../../src/app/formatters/action-display-formatter.js";
import { formatToolInfo } from "../../../src/app/formatters/summary-formatter.js";

describe("friendly action display", () => {
  it("gives every static agent action a human-readable English label", () => {
    for (const action of AGENT_ACTIONS) {
      const display = getFriendlyAgentActionDisplay(action);
      expect(display.icon, action.id).toBeTruthy();
      expect(display.label, action.id).toBeTruthy();
      expect(display.label, action.id).not.toContain(".");
      expect(display.label, action.id).not.toContain("_");
    }
  });

  it("renders Image AI actions with purpose-specific names instead of raw action IDs", () => {
    expect(getFriendlyActionDisplay("media", { action: "image.current" })).toEqual({ icon: "👁️", label: "Check Image Setup" });
    expect(getFriendlyActionDisplay("media", { action: "image.generate" })).toEqual({ icon: "🖼️", label: "Generate Image" });
    expect(getFriendlyActionDisplay("media", { action: "image.edit" })).toEqual({ icon: "✨", label: "Edit Image" });
  });

  it("renders SSH actions with human-friendly names", () => {
    expect(getFriendlyActionDisplay("ssh", { action: "status" })).toEqual({ icon: "🔌", label: "Check SSH Client" });
    expect(getFriendlyActionDisplay("ssh", { action: "key.public" })).toEqual({ icon: "🔑", label: "Show SSH Public Key" });
    expect(getFriendlyActionDisplay("ssh", { action: "exec" })).toEqual({ icon: "🖥️", label: "Run on Server" });
    expect(getFriendlyActionDisplay("ssh", { action: "upload" })).toEqual({ icon: "📤", label: "Upload to Server" });
  });

  it("never leaks the technical action name through the generic details fallback", () => {
    const text = formatToolInfo({
      sessionId: "s1",
      messageId: "m1",
      callId: "c1",
      tool: "media",
      state: { status: "completed", input: {}, output: "" },
      input: { action: "image.current" },
      title: "media image.current",
    } as never);
    expect(text).toBe("👁️ Check Image Setup");
    expect(text).not.toContain("image.current");
    expect(text).not.toContain("🛠️ media");
  });

  it("humanizes unknown dynamic tool names instead of dumping raw identifiers", () => {
    expect(getFriendlyActionDisplay("custom_mcp_search_tool")).toEqual({
      icon: "🔌",
      label: "Custom MCP Search Tool",
    });
  });
});
