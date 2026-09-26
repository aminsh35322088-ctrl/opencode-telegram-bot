import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tailscale = vi.hoisted(() => ({
  resolve: vi.fn(),
  ping: vi.fn(),
}));
const sshKeys = vi.hoisted(() => ({
  privateKey: vi.fn(),
  knownHosts: vi.fn(),
}));
const topics = vi.hoisted(() => ({
  findBySession: vi.fn(),
}));

vi.mock("../../../src/app/services/tailscale-integration-service.js", () => ({
  getTailscaleSocketPath: () => "/data/run/tailscale/tailscaled.sock",
  resolveTailscaleSshDevice: tailscale.resolve,
  pingTailscaleSshDevice: tailscale.ping,
}));

vi.mock("../../../src/app/services/ssh-key-service.js", () => ({
  getManagedSshPrivateKeyPath: sshKeys.privateKey,
  getManagedSshKnownHostsPath: sshKeys.knownHosts,
}));

vi.mock("../../../src/app/services/telegram-topic-store.js", () => ({
  findTelegramTopicBindingBySessionId: topics.findBySession,
}));

import {
  checkTailnetSsh,
  describeTailnetSshTarget,
  execTailnetSsh,
  hasActiveTailnetSshConnection,
  resolveTailnetSshScope,
  sanitizeSshLog,
  transferTailnetSshFile,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "../../../src/app/services/ssh-service.js";

function nativeDevice(target = "github-exit", identity = "node-a") {
  return {
    name: target,
    dnsName: `${target}.example.ts.net`,
    ips: ["100.64.0.10"],
    online: true,
    tags: ["tag:ssh"],
    os: "linux",
    identity,
    sshHostKeys: ["ssh-ed25519 AAAATEST"],
    nativeTailscaleSsh: true,
    sshEligible: true,
    sshReason: "eligible" as const,
  };
}

function standardDevice(target = "windows-host", identity = "node-win") {
  return {
    name: target,
    dnsName: `${target}.example.ts.net`,
    ips: ["100.64.0.20"],
    online: true,
    tags: ["tag:ssh"],
    os: "windows",
    identity,
    sshHostKeys: [],
    nativeTailscaleSsh: false,
    sshEligible: true,
    sshReason: "eligible" as const,
  };
}

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    ok: true,
    stdout: "",
    stderr: "",
    timedOut: false,
    exitCode: 0,
    signal: null,
    ...overrides,
  };
}

function controlPath(args: string[]): string | undefined {
  const index = args.indexOf("-S");
  return index >= 0 ? args[index + 1] : undefined;
}

function createMultiplexRunner(calls: CommandRequest[]) {
  const active = new Set<string>();
  const runner: CommandRunner = async (request) => {
    calls.push(request);
    const args = request.args;
    const socket = controlPath(args);

    if (args.includes("-O") && args.includes("check")) {
      return socket && active.has(socket)
        ? result({ stdout: "Master running\n" })
        : result({ ok: false, stderr: "Control socket connect failed", exitCode: 255 });
    }

    if (args.includes("ControlMaster=yes")) {
      if (socket) active.add(socket);
      return result();
    }

    if (args.includes("ProxyCommand=/bin/false")) {
      return socket && active.has(socket)
        ? result({ stdout: "channel-ok\n" })
        : result({ ok: false, stderr: "master unavailable", exitCode: 255 });
    }

    return result();
  };
  return { runner, active };
}

describe("pooled cross-platform Tailnet SSH service", () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    sshKeys.privateKey.mockReset().mockResolvedValue("/data/ssh/id_ed25519");
    sshKeys.knownHosts.mockReset().mockResolvedValue("/data/ssh/known_hosts");
    tailscale.resolve.mockReset().mockImplementation(async (target: string) => nativeDevice(target));
    tailscale.ping.mockReset().mockImplementation(async (target: string) => ({
      ok: true,
      device: nativeDevice(target),
      output: "pong",
    }));
    topics.findBySession.mockReset().mockResolvedValue({
      chatId: 777,
      threadId: 42,
      sessionId: "session-1",
      directory: "/data/workspace",
      createdAt: "2026-09-26T00:00:00.000Z",
      updatedAt: "2026-09-26T00:00:00.000Z",
    });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tailnet-ssh-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resolves a stable Telegram Topic scope across OpenCode session IDs", async () => {
    expect(await resolveTailnetSshScope("session-1")).toBe("topic:777:42");
    topics.findBySession.mockResolvedValueOnce(null);
    expect(await resolveTailnetSshScope("orphan-session")).toBe("session:orphan-session");
  });

  it("opens native Tailscale SSH with the proven socket-aware direct transport", async () => {
    const calls: CommandRequest[] = [];
    const { runner } = createMultiplexRunner(calls);

    const output = await execTailnetSsh({
      target: "github-exit",
      user: "runner",
      command: "uname -a",
      scope: "topic:777:42",
      allowConnectionStart: true,
    }, runner);

    expect(output.ok).toBe(true);
    expect(output.authMode).toBe("tailscale-ssh");
    expect(output.connectionCreated).toBe(true);
    expect(output.persistentConnection).toBe(true);

    const master = calls.find((call) => call.args.includes("ControlMaster=yes"));
    expect(master?.bin).toBe("/usr/bin/ssh");
    const args = master?.args.join(" ") ?? "";
    expect(args).toContain(
      "ProxyCommand=/usr/local/bin/tailscale --socket=/data/run/tailscale/tailscaled.sock nc %h %p",
    );
    expect(args).toContain("KexAlgorithms=ecdh-sha2-nistp256,curve25519-sha256");
    expect(args).toContain("HostKeyAlgorithms=ssh-ed25519");
    expect(args).toContain("ControlPersist=yes");
    expect(args).toContain("runner@github-exit");

    const channel = calls.find((call) => call.args.includes("ProxyCommand=/bin/false"));
    expect(channel?.args).toContain("uname -a");
  });

  it("reuses one master for multiple commands instead of reconnecting per command", async () => {
    const calls: CommandRequest[] = [];
    const { runner } = createMultiplexRunner(calls);
    const common = {
      target: "github-exit",
      user: "runner",
      scope: "topic:777:42",
    };

    const first = await execTailnetSsh({
      ...common,
      command: "uname -a",
      allowConnectionStart: true,
    }, runner);
    const second = await execTailnetSsh({
      ...common,
      command: "uptime",
      allowConnectionStart: false,
    }, runner);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.connectionReused).toBe(true);
    expect(calls.filter((call) => call.args.includes("ControlMaster=yes"))).toHaveLength(1);
    expect(calls.filter((call) => call.args.includes("ProxyCommand=/bin/false"))).toHaveLength(2);
  });

  it("fails closed and requires a new grant after the master connection disappears", async () => {
    const calls: CommandRequest[] = [];
    const { runner, active } = createMultiplexRunner(calls);
    const common = {
      target: "github-exit",
      user: "runner",
      scope: "topic:777:42",
    };

    const first = await execTailnetSsh({
      ...common,
      command: "true",
      allowConnectionStart: true,
    }, runner);
    expect(first.ok).toBe(true);

    active.clear();
    const second = await execTailnetSsh({
      ...common,
      command: "whoami",
      allowConnectionStart: false,
    }, runner);

    expect(second.ok).toBe(false);
    expect(second.diagnosis).toBe("authorization-expired");
    expect(calls.filter((call) => call.args.includes("ControlMaster=yes"))).toHaveLength(1);
  });

  it("requires a new grant when the Tailnet server identity changes", async () => {
    const calls: CommandRequest[] = [];
    const { runner } = createMultiplexRunner(calls);

    await execTailnetSsh({
      target: "github-exit",
      user: "runner",
      scope: "topic:777:42",
      command: "true",
      allowConnectionStart: true,
    }, runner);

    tailscale.resolve.mockImplementation(async (target: string) => nativeDevice(target, "node-b"));
    const changed = await execTailnetSsh({
      target: "github-exit",
      user: "runner",
      scope: "topic:777:42",
      command: "whoami",
      allowConnectionStart: false,
    }, runner);

    expect(changed.ok).toBe(false);
    expect(changed.diagnosis).toBe("authorization-expired");
  });

  it("requires a separate live master for a different Topic or username", async () => {
    const calls: CommandRequest[] = [];
    const { runner } = createMultiplexRunner(calls);

    await execTailnetSsh({
      target: "github-exit",
      user: "runner",
      scope: "topic:777:42",
      command: "true",
      allowConnectionStart: true,
    }, runner);

    expect(await hasActiveTailnetSshConnection({
      target: "github-exit",
      user: "runner",
      scope: "topic:777:42",
    }, runner)).toBe(true);

    expect(await hasActiveTailnetSshConnection({
      target: "github-exit",
      user: "runner",
      scope: "topic:777:43",
    }, runner)).toBe(false);

    expect(await hasActiveTailnetSshConnection({
      target: "github-exit",
      user: "root",
      scope: "topic:777:42",
    }, runner)).toBe(false);
  });

  it("uses a managed Ed25519 key over Tailscale for non-native SSH servers", async () => {
    tailscale.resolve.mockImplementation(async () => standardDevice());
    const calls: CommandRequest[] = [];
    const { runner } = createMultiplexRunner(calls);

    const description = await describeTailnetSshTarget({
      target: "windows-host",
      user: "Administrator",
      scope: "topic:777:42",
    });
    expect(description.authMode).toBe("managed-key");
    expect(description.passwordRequired).toBe(false);

    const output = await execTailnetSsh({
      target: "windows-host",
      user: "Administrator",
      scope: "topic:777:42",
      command: "ver",
      allowConnectionStart: true,
    }, runner);

    expect(output.ok).toBe(true);
    const master = calls.find((call) => call.args.includes("ControlMaster=yes"));
    const args = master?.args.join(" ") ?? "";
    expect(args).toContain("PasswordAuthentication=no");
    expect(args).toContain("PreferredAuthentications=publickey");
    expect(args).toContain("-i /data/ssh/id_ed25519");
    expect(args).toContain(
      "ProxyCommand=/usr/local/bin/tailscale --socket=/data/run/tailscale/tailscaled.sock nc %h %p",
    );
  });

  it("uses managed-key mode for custom ports such as Termux 8022", async () => {
    const calls: CommandRequest[] = [];
    const { runner } = createMultiplexRunner(calls);

    const output = await execTailnetSsh({
      target: "github-exit",
      user: "u0_a123",
      port: 8022,
      scope: "topic:777:42",
      command: "id",
      allowConnectionStart: true,
    }, runner);

    expect(output.authMode).toBe("managed-key");
    const master = calls.find((call) => call.args.includes("ControlMaster=yes"));
    expect(master?.args.join(" ")).toContain("-p 8022");
  });

  it("check verifies Tailnet reachability and establishes the approved master", async () => {
    const calls: CommandRequest[] = [];
    const { runner } = createMultiplexRunner(calls);

    const output = await checkTailnetSsh({
      target: "server-a",
      user: "ubuntu",
      scope: "topic:777:42",
      allowConnectionStart: true,
    }, runner);

    expect(output.ok).toBe(true);
    expect(output.tailnetReachable).toBe(true);
    expect(output.connectionCreated).toBe(true);
    expect(tailscale.ping).toHaveBeenCalledWith("server-a");
  });

  it("reuses the same master for SCP and fails closed instead of reconnecting", async () => {
    const source = path.join(dir, "upload.txt");
    await fs.writeFile(source, "hello");
    const calls: CommandRequest[] = [];
    const { runner } = createMultiplexRunner(calls);

    const output = await transferTailnetSshFile({
      target: "github-exit",
      user: "runner",
      scope: "topic:777:42",
      localPath: source,
      remotePath: "/tmp/upload.txt",
      direction: "upload",
      allowConnectionStart: true,
    }, runner);

    expect(output.ok).toBe(true);
    const scp = calls.find((call) => call.bin === "/usr/bin/scp");
    expect(scp?.args.join(" ")).toContain("ControlPath=");
    expect(scp?.args.join(" ")).toContain("ProxyCommand=/bin/false");
    expect(calls.filter((call) => call.args.includes("ControlMaster=yes"))).toHaveLength(1);
  });

  it("rejects unsafe usernames, ports, and remote paths", async () => {
    const calls: CommandRequest[] = [];
    const { runner } = createMultiplexRunner(calls);

    await expect(
      execTailnetSsh({
        target: "server",
        user: "root;id",
        scope: "topic:777:42",
        command: "true",
        allowConnectionStart: true,
      }, runner),
    ).rejects.toThrow(/user/i);

    await expect(
      execTailnetSsh({
        target: "server",
        user: "root",
        port: 70000,
        scope: "topic:777:42",
        command: "true",
        allowConnectionStart: true,
      }, runner),
    ).rejects.toThrow(/port/i);

    const source = path.join(dir, "upload.txt");
    await fs.writeFile(source, "hello");
    await expect(
      transferTailnetSshFile({
        target: "server",
        user: "root",
        scope: "topic:777:42",
        localPath: source,
        remotePath: "/tmp/a;id",
        direction: "upload",
        allowConnectionStart: true,
      }, runner),
    ).rejects.toThrow(/remote_path/i);
  });

  it("redacts credential-like material from debug logs", () => {
    const sanitized = sanitizeSshLog("token=abc123 password=hunter2\nBearer secret.value");
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("secret.value");
    expect(sanitized).toContain("[REDACTED]");
  });
});
