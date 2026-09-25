import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tailscale = vi.hoisted(() => ({
  resolve: vi.fn(async (target: string) => ({
    name: target,
    dnsName: `${target}.example.ts.net`,
    ips: ["100.64.0.10"],
    online: true,
    tags: ["tag:ssh"],
  })),
  ping: vi.fn(async (target: string) => ({
    ok: true,
    device: { name: target, ips: ["100.64.0.10"], online: true, tags: ["tag:ssh"] },
    output: "pong",
  })),
}));

vi.mock("../../../src/app/services/tailscale-integration-service.js", () => ({
  getTailscaleSocketPath: () => "/data/run/tailscale/tailscaled.sock",
  resolveTailscaleSshDevice: tailscale.resolve,
  pingTailscaleSshDevice: tailscale.ping,
}));

import {
  checkTailnetSsh,
  execTailnetSsh,
  sanitizeSshLog,
  transferTailnetSshFile,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "../../../src/app/services/ssh-service.js";

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, stdout: "", stderr: "", timedOut: false, exitCode: 0, signal: null, ...overrides };
}

describe("Tailnet-only SSH service", () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tailnet-ssh-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("always uses the Tailscale userspace ProxyCommand and default KEX first", async () => {
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => {
      calls.push(request);
      return result({ stdout: "ok\n" });
    };

    const output = await execTailnetSsh({
      target: "github-exit",
      user: "runner",
      command: "uname -a",
    }, runner);

    expect(output.ok).toBe(true);
    expect(tailscale.resolve).toHaveBeenCalledWith("github-exit");
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args.join(" ");
    expect(args).toContain("ProxyCommand=/usr/local/bin/tailscale --socket=/data/run/tailscale/tailscaled.sock nc %h %p");
    expect(args).not.toContain("KexAlgorithms=");
    expect(args).toContain("runner@github-exit");
  });

  it("falls back to ecdh-nistp256 only after a default handshake timeout", async () => {
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => {
      calls.push(request);
      return calls.length === 1
        ? result({ ok: false, timedOut: true, exitCode: null, signal: "SIGTERM" })
        : result({ stdout: "fallback-ok\n" });
    };

    const output = await execTailnetSsh({
      target: "github-exit",
      user: "runner",
      command: "true",
      timeoutMs: 3000,
    }, runner);

    expect(output.ok).toBe(true);
    expect(output.compatibility).toBe("ecdh-nistp256");
    expect(output.workingOverrides).toEqual(["KexAlgorithms=ecdh-sha2-nistp256"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args.join(" ")).not.toContain("KexAlgorithms=");
    expect(calls[1]!.args.join(" ")).toContain("KexAlgorithms=ecdh-sha2-nistp256");
  });

  it("check verifies Tailnet reachability before the SSH probe", async () => {
    const runner: CommandRunner = async () => result();
    const output = await checkTailnetSsh({ target: "server-a", user: "ubuntu" }, runner);
    expect(output.ok).toBe(true);
    expect(output.tailnetReachable).toBe(true);
    expect(tailscale.ping).toHaveBeenCalledWith("server-a");
  });

  it("uploads with SCP only through the Tailscale ProxyCommand", async () => {
    const source = path.join(dir, "upload.txt");
    await fs.writeFile(source, "hello");
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => { calls.push(request); return result(); };

    const output = await transferTailnetSshFile({
      target: "server-a",
      user: "ubuntu",
      localPath: source,
      remotePath: "/tmp/upload.txt",
      direction: "upload",
    }, runner);

    expect(output.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.join(" ")).toContain("ProxyCommand=/usr/local/bin/tailscale --socket=/data/run/tailscale/tailscaled.sock nc %h %p");
  });

  it("rejects unsafe usernames and remote paths", async () => {
    const runner: CommandRunner = async () => result();
    await expect(execTailnetSsh({ target: "server", user: "root;id", command: "true" }, runner)).rejects.toThrow(/user/i);
    const source = path.join(dir, "upload.txt");
    await fs.writeFile(source, "hello");
    await expect(transferTailnetSshFile({
      target: "server",
      user: "root",
      localPath: source,
      remotePath: "/tmp/a;id",
      direction: "upload",
    }, runner)).rejects.toThrow(/remote_path/i);
  });

  it("redacts credential-like material from debug logs", () => {
    const sanitized = sanitizeSshLog("token=abc123 password=hunter2\nBearer secret.value");
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("secret.value");
    expect(sanitized).toContain("[REDACTED]");
  });
});
