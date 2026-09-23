import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("SSH tool contract", () => {
  it("is direct-only and keeps the private key out of the model-facing schema", async () => {
    const source = await fs.readFile(path.join(process.cwd(), ".opencode", "tools", "ssh.ts"), "utf8");

    expect(source).toContain("StrictHostKeyChecking=accept-new");
    expect(source).toContain("IdentitiesOnly=yes");
    expect(source).toContain("BatchMode=yes");
    expect(source).toContain("validateTransferRemotePath");
    expect(source).toContain("local path must stay inside the current worktree");
    expect(source).not.toContain("cloudflared");
    expect(source).not.toContain("cloudflare");
    expect(source).not.toContain("clientSecret");
    expect(source).not.toContain("privateKey: tool.schema");
  });

  it("keeps SSH setup discoverable in the existing Integrations panel", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "src", "bot", "commands", "integrations-command.ts"), "utf8");

    expect(source).toContain("🔑 SSH Public Key");
    expect(source).toContain("integration:ssh:key");
    expect(source).toContain("Direct connections");
    expect(source).not.toContain("Cloudflare");
    expect(source).toContain("editMessageText");
  });

  it("does not install cloudflared in the production image", async () => {
    const dockerfile = await fs.readFile(path.join(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).not.toContain("cloudflared");
  });

  it("registers the SSH tool in OpenCode permissions", async () => {
    const config = JSON.parse(await fs.readFile(path.join(process.cwd(), "opencode.json"), "utf8")) as {
      permission?: Record<string, unknown>;
    };
    expect(config.permission?.ssh).toBe("allow");
  });
});
