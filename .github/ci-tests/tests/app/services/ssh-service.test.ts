import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tailscale = vi.hoisted(() => ({ resolve: vi.fn(), ping: vi.fn() }));
vi.mock("../../../src/app/services/tailscale-integration-service.js", () => ({
  getTailscaleSocketPath: () => "/data/run/tailscale/tailscaled.sock",
  resolveTailscaleSshDevice: tailscale.resolve,
  pingTailscaleSshDevice: tailscale.ping,
}));
vi.mock("../../../src/app/services/ssh-key-service.js", () => ({
  getManagedSshPrivateKeyPath: vi.fn().mockResolvedValue("/data/ssh/id_ed25519"),
  getManagedSshKnownHostsPath: vi.fn().mockResolvedValue("/data/ssh/known_hosts"),
}));

import {
  checkTailnetSsh, describeTailnetSshTarget, execTailnetSsh, sanitizeSshLog,
  transferTailnetSshFile, type CommandRequest, type CommandResult, type CommandRunner,
} from "../../../src/app/services/ssh-service.js";

function nativeDevice(target = "github-exit") {
  return {
    name: target, dnsName: `${target}.example.ts.net`, ips: ["100.64.0.10"],
    online: true, tags: ["tag:ssh"], os: "linux",
    sshHostKeys: ["ssh-ed25519 AAAATEST"], nativeTailscaleSsh: true,
    sshEligible: true, sshReason: "eligible" as const,
  };
}
function standardDevice(target = "windows-host") {
  return {
    name: target, dnsName: `${target}.example.ts.net`, ips: ["100.64.0.20"],
    online: true, tags: ["tag:ssh"], os: "windows",
    sshHostKeys: [], nativeTailscaleSsh: false,
    sshEligible: true, sshReason: "eligible" as const,
  };
}
function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, stdout: "", stderr: "", timedOut: false, exitCode: 0, signal: null, ...overrides };
}

describe("cross-platform Tailnet SSH service", () => {
  let dir: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    tailscale.resolve.mockResolvedValue(nativeDevice());
    tailscale.ping.mockImplementation(async (target: string) => ({
      ok: true, device: nativeDevice(target), output: "pong",
    }));
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tailnet-ssh-"));
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("uses the official tailscale ssh wrapper for native Tailscale SSH", async () => {
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => { calls.push(request); return result({ stdout: "ok\n" }); };
    const output = await execTailnetSsh({ target: "github-exit", user: "runner", command: "uname -a" }, runner);
    expect(output.ok).toBe(true);
    expect(output.authMode).toBe("tailscale-ssh");
    expect(output.passwordRequired).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe("/usr/local/bin/tailscale");
    expect(calls[0]!.args).toEqual([
      "--socket=/data/run/tailscale/tailscaled.sock", "ssh", "runner@github-exit", "uname -a",
    ]);
  });

  it("retries native SSH with only the safe KEX override after timeout", async () => {
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => {
      calls.push(request);
      return calls.length === 1
        ? result({ ok: false, timedOut: true, exitCode: null, signal: "SIGTERM" })
        : result({ stdout: "fallback-ok\n" });
    };
    const output = await execTailnetSsh({
      target: "github-exit", user: "runner", command: "exit 0", timeoutMs: 3000,
    }, runner);
    expect(output.ok).toBe(true);
    expect(output.compatibility).toBe("ecdh-nistp256");
    expect(output.workingOverrides).toEqual(["KexAlgorithms=ecdh-sha2-nistp256"]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.bin === "/usr/local/bin/tailscale")).toBe(true);
    expect(calls[1]!.env?.PATH).toMatch(/^\/tmp\/opencode-ts-ssh-/u);
  });

  it("uses passwordless managed-key SSH over Tailscale for non-native targets", async () => {
    tailscale.resolve.mockResolvedValue(standardDevice());
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => { calls.push(request); return result({ stdout: "Windows\n" }); };
    const description = await describeTailnetSshTarget({ target: "windows-host", user: "Administrator" });
    expect(description.authMode).toBe("managed-key");
    expect(description.passwordRequired).toBe(false);
    const output = await execTailnetSsh({ target: "windows-host", user: "Administrator", command: "ver" }, runner);
    expect(output.ok).toBe(true);
    expect(output.authMode).toBe("managed-key");
    const args = calls[0]!.args.join(" ");
    expect(calls[0]!.bin).toBe("/usr/bin/ssh");
    expect(args).toContain("ProxyCommand=/usr/local/bin/tailscale --socket=/data/run/tailscale/tailscaled.sock nc %h %p");
    expect(args).toContain("PasswordAuthentication=no");
    expect(args).toContain("PreferredAuthentications=publickey");
    expect(args).toContain("-i /data/ssh/id_ed25519");
  });

  it("uses managed-key mode for custom SSH ports", async () => {
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => { calls.push(request); return result(); };
    const output = await execTailnetSsh({
      target: "github-exit", user: "u0_a123", port: 8022, command: "id",
    }, runner);
    expect(output.authMode).toBe("managed-key");
    expect(calls[0]!.bin).toBe("/usr/bin/ssh");
    expect(calls[0]!.args.join(" ")).toContain("-p 8022");
  });

  it("check verifies Tailnet reachability before SSH", async () => {
    const runner: CommandRunner = async () => result();
    const output = await checkTailnetSsh({ target: "server-a", user: "ubuntu" }, runner);
    expect(output.ok).toBe(true);
    expect(output.tailnetReachable).toBe(true);
    expect(output.passwordRequired).toBe(false);
    expect(tailscale.ping).toHaveBeenCalledWith("server-a");
  });

  it("preflights native Tailscale SSH before SCP", async () => {
    const source = path.join(dir, "upload.txt");
    await fs.writeFile(source, "hello");
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => { calls.push(request); return result(); };
    const output = await transferTailnetSshFile({
      target: "github-exit", user: "runner", localPath: source,
      remotePath: "/tmp/upload.txt", direction: "upload",
    }, runner);
    expect(output.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.bin).toBe("/usr/local/bin/tailscale");
    expect(calls[1]!.bin).toBe("/usr/bin/scp");
  });

  it("rejects unsafe usernames, ports, and remote paths", async () => {
    const runner: CommandRunner = async () => result();
    await expect(execTailnetSsh({ target: "server", user: "root;id", command: "true" }, runner)).rejects.toThrow(/user/i);
    await expect(execTailnetSsh({ target: "server", user: "root", port: 70000, command: "true" }, runner)).rejects.toThrow(/port/i);
    const source = path.join(dir, "upload.txt");
    await fs.writeFile(source, "hello");
    await expect(transferTailnetSshFile({
      target: "server", user: "root", localPath: source,
      remotePath: "/tmp/a;id", direction: "upload",
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
