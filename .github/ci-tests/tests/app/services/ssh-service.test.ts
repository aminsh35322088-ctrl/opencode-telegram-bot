import { describe, expect, it } from "vitest";
import {
  execSshCommand,
  resolveSshTransport,
  sanitizeSshLog,
  validateSshTarget,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "../../../src/app/services/ssh-service.js";

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

describe("ssh service", () => {
  it("detects a MagicDNS/Tailnet peer in auto mode", async () => {
    const runner: CommandRunner = async (request) => {
      expect(request.args).toEqual(["status", "--json"]);
      return result({
        stdout: JSON.stringify({
          Peer: {
            key: {
              HostName: "github-exit",
              DNSName: "github-exit.tail57d500.ts.net.",
              TailscaleIPs: ["100.87.174.77"],
              Online: true,
              Tags: ["tag:exit", "tag:ssh"],
            },
          },
        }),
      });
    };
    const resolved = await resolveSshTransport({ host: "github-exit", transport: "auto" }, runner);
    expect(resolved.transport).toBe("tailscale");
    expect(resolved.peer?.Tags).toContain("tag:ssh");
  });

  it("keeps direct VPS SSH on standard negotiation by default", async () => {
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => {
      calls.push(request);
      return result({ stdout: "ok\n" });
    };
    const output = await execSshCommand({
      host: "vps.example.com",
      user: "ubuntu",
      transport: "direct",
      command: "uname -a",
    }, runner);
    expect(output.ok).toBe(true);
    expect(output.transport).toBe("direct");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.join(" ")).not.toContain("KexAlgorithms=");
  });

  it("falls back to ecdh-nistp256 only after a Tailscale default handshake timeout", async () => {
    const calls: CommandRequest[] = [];
    let sshAttempts = 0;
    const runner: CommandRunner = async (request) => {
      calls.push(request);
      if (request.args[0] === "status") {
        return result({ stdout: JSON.stringify({ Peer: { x: { HostName: "github-exit", TailscaleIPs: ["100.87.174.77"], Online: true } } }) });
      }
      if (request.args[0] === "ssh") {
        sshAttempts += 1;
        if (sshAttempts === 1) return result({ ok: false, timedOut: true, exitCode: null, signal: "SIGTERM" });
        expect(request.env?.PATH).toMatch(/^\/tmp\/opencode-ssh-/u);
        return result({ stdout: "runner-ok\n" });
      }
      throw new Error(`unexpected command: ${request.bin} ${request.args.join(" ")}`);
    };
    const output = await execSshCommand({
      host: "github-exit",
      user: "runner",
      transport: "auto",
      compatibility: "auto",
      command: "true",
      timeoutMs: 3_000,
    }, runner);
    expect(output.ok).toBe(true);
    expect(output.transport).toBe("tailscale");
    expect(output.compatibility).toBe("ecdh-nistp256");
    expect(output.workingOverrides).toEqual(["KexAlgorithms=ecdh-sha2-nistp256"]);
    expect(sshAttempts).toBe(2);
  });

  it("rejects shell syntax in host/user fields", () => {
    expect(() => validateSshTarget({ host: "example.com;rm -rf /" })).toThrow(/host/u);
    expect(() => validateSshTarget({ host: "server", user: "root;id" })).toThrow(/user/u);
  });

  it("redacts credential-like material from debug logs", () => {
    const sanitized = sanitizeSshLog("token=abc123 password=hunter2\nBearer secret.value");
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("secret.value");
    expect(sanitized).toContain("[REDACTED]");
  });
});
