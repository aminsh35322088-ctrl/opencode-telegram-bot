import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";

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

  it("keeps every repository custom tool action-based and registered", async () => {
    const toolsDir = path.join(process.cwd(), ".opencode", "tools");
    const files = (await fs.readdir(toolsDir)).filter((name) => name.endsWith(".ts")).sort();
    const registeredTools = Object.keys(CUSTOM_TOOL_ACTIONS).map((name) => `${name}.ts`).sort();
    expect(registeredTools).toEqual(files);

    for (const file of files) {
      const source = await fs.readFile(path.join(toolsDir, file), "utf8");
      expect(source, `${file} must expose an explicit action schema`).toContain("action: tool.schema");
    }
  });

  it("parses every repository custom tool without TypeScript syntax errors", async () => {
    const toolsDir = path.join(process.cwd(), ".opencode", "tools");
    const files = (await fs.readdir(toolsDir)).filter((name) => name.endsWith(".ts")).sort();
    for (const file of files) {
      const source = await fs.readFile(path.join(toolsDir, file), "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
      expect(parsed.parseDiagnostics, file).toEqual([]);
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
    expect(getAgentAction("file.delete")?.risk).toBe("destructive");
    expect(getAgentAction("git.reset")?.risk).toBe("destructive");
    expect(getAgentAction("notify.send")?.risk).toBe("external");
    expect(getAgentAction("session-extended.export")?.risk).toBe("write");
  });

  it("supports discovery filters and summary counts", () => {
    expect(listAgentActions({ tool: "media" }).map((item) => item.id)).toContain("media.stt.transcribe");
    expect(listAgentActions({ query: "scheduled" }).some((item) => item.id === "bot.tasks.create")).toBe(true);
    const summary = summarizeAgentActions() as { total: number };
    expect(summary.total).toBe(AGENT_ACTIONS.length);
    expect(summary.total).toBeGreaterThan(100);
  });
});
