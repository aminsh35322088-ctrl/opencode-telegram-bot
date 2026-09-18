import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAgentAction } from "../../../src/app/services/agent-action-registry.js";

const REQUIRED = [
  "github-ci.dispatch", "github-ci.jobs", "github-ci.rerun-failed", "github-ci.cancel",
  "telegram.context.current", "telegram.reply.resolve", "telegram.forward.inspect", "telegram.media.fetch",
  "media.video.prepare", "media.stt.status", "media.stt.transcribe",
  "media.image.models", "media.image.current", "media.image.generate", "media.image.edit",
  "bot.mcp.list", "bot.mcp.add-local", "bot.mcp.add-remote", "bot.mcp.enable", "bot.mcp.disable",
  "bot.skills.list", "bot.skills.create", "bot.skills.update", "bot.skills.delete", "bot.skills.import", "skill.load",
  "session.fork", "session.revert", "session.unrevert", "session.summarize", "session.abort",
  "session.diff", "session.todo", "session.children",
] as const;

describe("expanded model-facing action surface", () => {
  it("keeps the deferred action checklist registered", () => {
    for (const id of REQUIRED) expect(getAgentAction(id), id).not.toBeNull();
    expect(getAgentAction("permission.reply")).toBeNull();
  });

  it("assigns conservative risk to new mutating actions", () => {
    expect(getAgentAction("github-ci.dispatch")?.risk).toBe("mutating");
    expect(getAgentAction("github-ci.cancel")?.risk).toBe("mutating");
    expect(getAgentAction("telegram.media.fetch")?.risk).toBe("write");
    expect(getAgentAction("session.revert")?.risk).toBe("destructive");
    expect(getAgentAction("session.diff")?.risk).toBe("read");
  });

  it("backs the registered IDs with concrete OpenCode tool implementations", async () => {
    const [github, telegram, media, session] = await Promise.all([
      fs.readFile(".opencode/tools/github-ci.ts", "utf8"),
      fs.readFile(".opencode/tools/telegram.ts", "utf8"),
      fs.readFile(".opencode/tools/media.ts", "utf8"),
      fs.readFile(".opencode/tools/session.ts", "utf8"),
    ]);
    for (const action of ["dispatch", "jobs", "rerun-failed", "cancel"]) expect(github).toContain(`"${action}"`);
    for (const action of ["context.current", "reply.resolve", "forward.inspect", "media.fetch"]) expect(telegram).toContain(`"${action}"`);
    expect(media).toContain('"video.prepare"');
    for (const action of ["session.fork", "session.revert", "session.unrevert", "session.summarize", "session.abort", "session.diff", "session.todo", "session.children"]) expect(session).toContain(`"${action.replace("session.", "")}"`);
  });
});