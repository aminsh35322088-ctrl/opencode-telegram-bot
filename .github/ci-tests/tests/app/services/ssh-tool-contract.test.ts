import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("SSH + Cloudflare tool contract", () => {
  it("keeps Cloudflare service credentials outside the model-facing schema", async () => {
    const source = await fs.readFile(path.join(process.cwd(), ".opencode", "tools", "ssh.ts"), "utf8");

    expect(source).toContain('TUNNEL_SERVICE_TOKEN_ID');
    expect(source).toContain('TUNNEL_SERVICE_TOKEN_SECRET');
    expect(source).toContain('ProxyCommand=');
    expect(source).toContain('cloudflared');
    expect(source).not.toContain('clientId: tool.schema');
    expect(source).not.toContain('clientSecret: tool.schema');
    expect(source).toContain('StrictHostKeyChecking=accept-new');
    expect(source).toContain('validateTransferRemotePath');
    expect(source).toContain('local path must stay inside the current worktree');
  });

  it("pins cloudflared to the verified headless-compatible release", async () => {
    const dockerfile = await fs.readFile(path.join(process.cwd(), "Dockerfile"), "utf8");

    expect(dockerfile).toContain("CLOUDFLARED_VERSION=2026.5.1");
    expect(dockerfile).toContain("3c6a5ba995a258dbe90f98e5fdb2c2620b7be72c3ca761614f6eb52aee252cea");
    expect(dockerfile).toContain("7b7a8b9a2764acab0fecda633cb54a6c0df42d7f8ca1ec45c78333c2227d8d91");
    expect(dockerfile).toContain("sha256sum -c -");
  });

  it("keeps SSH setup discoverable in the existing Integrations panel", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "src", "bot", "commands", "integrations-command.ts"), "utf8");

    expect(source).toContain("☁️ Add Cloudflare SSH");
    expect(source).toContain("🔑 SSH Public Key");
    expect(source).toContain("integration:ssh:key");
    expect(source).toContain("OPENCODE_BOT_SSH_PUBLIC_KEY");
    expect(source).toContain("editMessageText");
  });

  it("registers the SSH tool in OpenCode permissions", async () => {
    const config = JSON.parse(await fs.readFile(path.join(process.cwd(), "opencode.json"), "utf8")) as {
      permission?: Record<string, unknown>;
    };
    expect(config.permission?.ssh).toBe("allow");
  });
});
