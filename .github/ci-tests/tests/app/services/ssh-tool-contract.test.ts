import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("direct SSH tool contract", () => {
  it("keeps private credentials out of the model-facing schema", async () => {
    const source = await fs.readFile(path.join(process.cwd(), ".opencode", "tools", "ssh.ts"), "utf8");

    expect(source).toContain('action: tool.schema.enum(["status", "key.ensure", "key.public", "exec", "read", "write", "upload", "download"])');
    expect(source).toContain("BatchMode=yes");
    expect(source).toContain("IdentitiesOnly=yes");
    expect(source).toContain("StrictHostKeyChecking=accept-new");
    expect(source).toContain("opencode_ed25519");
    expect(source).not.toContain("password: tool.schema");
    expect(source).not.toContain("privateKey: tool.schema");
    expect(source).not.toContain("ProxyCommand=");
  });

  it("constrains file transfer paths and timeouts", async () => {
    const source = await fs.readFile(path.join(process.cwd(), ".opencode", "tools", "ssh.ts"), "utf8");

    expect(source).toContain("localPath must stay inside the current worktree");
    expect(source).toContain("upload/download remotePath is limited to safe path characters");
    expect(source).toContain("MAX_TIMEOUT_MS = 120_000");
    expect(source).toContain("localPath must reference an existing regular file");
  });

  it("registers SSH in OpenCode permissions", async () => {
    const config = JSON.parse(await fs.readFile(path.join(process.cwd(), "opencode.json"), "utf8")) as {
      permission?: Record<string, unknown>;
    };
    expect(config.permission?.ssh).toBe("allow");
  });
});
