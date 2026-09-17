import { describe, expect, it } from "vitest";

import {
  AGENT_ACTIONS,
  CORE_TOOL_ACTIONS,
  CUSTOM_TOOL_ACTIONS,
  getAgentAction,
  listAgentActions,
  summarizeAgentActions,
} from "../../../src/app/services/agent-action-registry.js";

describe("agent action registry", () => {
  it("registers every declared core and custom action exactly once", () => {
    const ids = AGENT_ACTIONS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const [tool, actions] of Object.entries(CORE_TOOL_ACTIONS)) {
      for (const action of actions) expect(getAgentAction(`${tool}.${action}`)).not.toBeNull();
    }
    for (const [tool, actions] of Object.entries(CUSTOM_TOOL_ACTIONS)) {
      for (const action of actions) expect(getAgentAction(`${tool}.${action}`)).not.toBeNull();
    }
  });

  it("returns canonical invocation metadata", () => {
    expect(getAgentAction("bash.exec")?.invocation).toEqual({ kind: "native-tool", tool: "bash" });
    expect(getAgentAction("bot.tasks.create")?.invocation).toEqual({
      kind: "action-tool",
      tool: "bot",
      actionArgument: "action",
      actionValue: "tasks.create",
    });
  });

  it("classifies sensitive and external actions", () => {
    expect(getAgentAction("bot.tasks.delete")?.risk).toBe("destructive");
    expect(getAgentAction("bot.settings.set")?.risk).toBe("mutating");
    expect(getAgentAction("media.image.generate")?.risk).toBe("external");
    expect(getAgentAction("rustdesk.system.restart")?.risk).toBe("destructive");
  });

  it("supports discovery filters and summary counts", () => {
    expect(listAgentActions({ tool: "media" }).map((item) => item.id)).toContain("media.stt.transcribe");
    expect(listAgentActions({ query: "scheduled" }).some((item) => item.id === "bot.tasks.create")).toBe(true);
    const summary = summarizeAgentActions() as { total: number };
    expect(summary.total).toBe(AGENT_ACTIONS.length);
    expect(summary.total).toBeGreaterThan(100);
  });
});
