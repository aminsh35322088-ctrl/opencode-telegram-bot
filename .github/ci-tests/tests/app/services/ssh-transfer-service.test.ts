import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transferSshFile } from "../../../src/app/services/ssh-transfer-service.js";
import type { CommandRequest, CommandResult, CommandRunner } from "../../../src/app/services/ssh-service.js";

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return { ok: true, stdout: "", stderr: "", timedOut: false, exitCode: 0, signal: null, ...overrides };
}

describe("ssh transfer service", () => {
  let dir: string;
  let source: string;
  let destination: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-transfer-"));
    source = path.join(dir, "source.txt");
    destination = path.join(dir, "destination.txt");
    await fs.writeFile(source, "hello");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps direct SCP on normal KEX negotiation", async () => {
    const calls: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => {
      calls.push(request);
      return result();
    };
    const output = await transferSshFile({
      host: "vps.example.com",
      user: "ubuntu",
      transport: "direct",
      localPath: source,
      remotePath: "/tmp/source.txt",
      direction: "upload",
    }, runner);
    expect(output.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.join(" ")).not.toContain("KexAlgorithms=");
    expect(calls[0]!.args.join(" ")).not.toContain("tailscale nc");
  });

  it("adds Tailscale ProxyCommand and retries only the KEX on timeout", async () => {
    const calls: CommandRequest[] = [];
    let scpAttempts = 0;
    const runner: CommandRunner = async (request) => {
      calls.push(request);
      if (request.args[0] === "status") {
        return result({ stdout: JSON.stringify({ Peer: { x: { HostName: "github-exit", TailscaleIPs: ["100.87.174.77"], Online: true } } }) });
      }
      scpAttempts += 1;
      if (scpAttempts === 1) return result({ ok: false, timedOut: true, exitCode: null, signal: "SIGTERM" });
      return result();
    };
    const output = await transferSshFile({
      host: "github-exit",
      user: "runner",
      transport: "auto",
      compatibility: "auto",
      timeoutMs: 3000,
      localPath: source,
      remotePath: "/tmp/source.txt",
      direction: "upload",
    }, runner);
    expect(output.ok).toBe(true);
    expect(output.compatibility).toBe("ecdh-nistp256");
    const scpCalls = calls.filter((call) => call.bin.endsWith("/scp"));
    expect(scpCalls).toHaveLength(2);
    expect(scpCalls[0]!.args.join(" ")).toContain("ProxyCommand=/usr/local/bin/tailscale nc %h %p");
    expect(scpCalls[0]!.args.join(" ")).not.toContain("KexAlgorithms=");
    expect(scpCalls[1]!.args.join(" ")).toContain("KexAlgorithms=ecdh-sha2-nistp256");
  });

  it("creates the download destination parent and reports downloaded bytes", async () => {
    const runner: CommandRunner = async (request) => {
      if (request.bin.endsWith("/scp")) {
        const local = request.args.at(-1)!;
        await fs.mkdir(path.dirname(local), { recursive: true });
        await fs.writeFile(local, "downloaded");
      }
      return result();
    };
    const output = await transferSshFile({
      host: "vps.example.com",
      user: "ubuntu",
      transport: "direct",
      localPath: destination,
      remotePath: "/tmp/remote.txt",
      direction: "download",
    }, runner);
    expect(output.ok).toBe(true);
    expect(output.bytes).toBe(10);
    await expect(fs.readFile(destination, "utf8")).resolves.toBe("downloaded");
  });
});
