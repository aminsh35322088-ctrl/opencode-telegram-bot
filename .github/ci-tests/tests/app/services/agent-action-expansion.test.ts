import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAgentAction } from "../../../src/app/services/agent-action-registry.js";

const REQUIRED = [
  "github-ci.dispatch", "github-ci.jobs", "github-ci.rerun-failed", "github-ci.cancel",
  "telegram.context.current", "telegram.reply.resolve", "telegram.forward.inspect", "telegram.media.fetch",
  "media.video.prepare", "media.stt.status", "media.stt.transcribe",
  "media.image.models", "media.image.current", "media.image.generate", "media.image.edit",
  "bot.mcp.list", "bot.mcp.debug", "bot.mcp.add-local", "bot.mcp.add-remote", "bot.mcp.enable", "bot.mcp.rename", "bot.mcp.delete",
  "bot.skills.list", "bot.skills.create", "bot.skills.update", "bot.skills.delete", "bot.skills.import", "skill.load",
  "session.fork", "session.revert", "session.unrevert", "session.summarize", "session.abort",
  "session.diff", "session.todo", "session.children",
  "tailscale.status", "tailscale.devices", "tailscale.ping", "ssh.check", "ssh.debug", "ssh.exec", "ssh.upload", "ssh.download",
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
    expect(getAgentAction("bot.mcp.debug")?.risk).toBe("mutating");
    expect(getAgentAction("bot.mcp.rename")?.risk).toBe("mutating");
    expect(getAgentAction("bot.mcp.delete")?.risk).toBe("destructive");
    expect(getAgentAction("ssh.check")?.risk).toBe("read");
    expect(getAgentAction("ssh.debug")?.risk).toBe("read");
    expect(getAgentAction("ssh.exec")?.risk).toBe("mutating");
    expect(getAgentAction("ssh.upload")?.risk).toBe("mutating");
    expect(getAgentAction("ssh.download")?.risk).toBe("write");
    expect(getAgentAction("tailscale.status")?.risk).toBe("read");
    expect(getAgentAction("tailscale.ping")?.risk).toBe("external");
  });

  it("backs the registered IDs with concrete OpenCode tool implementations", async () => {
    const [github, telegram, media, session, bot] = await Promise.all([
      fs.readFile(".opencode/tools/github-ci.ts", "utf8"),
      fs.readFile(".opencode/tools/telegram.ts", "utf8"),
      fs.readFile(".opencode/tools/media.ts", "utf8"),
      fs.readFile(".opencode/tools/session.ts", "utf8"),
      fs.readFile(".opencode/tools/bot.ts", "utf8"),
    ]);
    for (const action of ["dispatch", "jobs", "rerun-failed", "cancel"]) expect(github).toContain(`"${action}"`);
    for (const action of ["context.current", "reply.resolve", "forward.inspect", "media.fetch"]) expect(telegram).toContain(`"${action}"`);
    expect(media).toContain('"video.prepare"');
    for (const action of ["session.fork", "session.revert", "session.unrevert", "session.summarize", "session.abort", "session.diff", "session.todo", "session.children"]) expect(session).toContain(`"${action.replace("session.", "")}"`);
    expect(bot).toContain('"mcp.debug"');
    expect(bot).toContain('"mcp.rename"');
    expect(bot).toContain('"mcp.delete"');
    expect(bot).not.toContain('"mcp.disable"');
    const [ssh, tailscale] = await Promise.all([fs.readFile(".opencode/tools/ssh.ts", "utf8"), fs.readFile(".opencode/tools/tailscale.ts", "utf8")]);
    for (const action of ["check", "debug", "exec", "upload", "download"]) expect(ssh).toContain(`"${action}"`);
    for (const action of ["status", "devices", "ping"]) expect(tailscale).toContain(`"${action}"`);
  });

  it("keeps SSH Tailnet-only and permission-gated", async () => {
    const [sshTool, tailscaleTool, opencodeConfigText] = await Promise.all([
      fs.readFile(".opencode/tools/ssh.ts", "utf8"),
      fs.readFile(".opencode/tools/tailscale.ts", "utf8"),
      fs.readFile("opencode.json", "utf8"),
    ]);
    const opencodeConfig = JSON.parse(opencodeConfigText) as { permission?: Record<string, unknown> };
    expect(opencodeConfig.permission?.ssh).toBe("ask");
    expect(opencodeConfig.permission?.tailscale).toBe("allow");
    expect(sshTool).toContain("SSH only to Tailnet peers");
    expect(sshTool).not.toContain("transport:");
    expect(sshTool).not.toContain("credential_id");
    expect(sshTool).not.toContain("profile_id");
    expect(sshTool).not.toContain("password: tool.schema");
    expect(sshTool).not.toContain("private_key: tool.schema");
    expect(tailscaleTool).toContain("tag:ssh");
  });

});