import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("bot-managed Tailscale integration", () => {
  let home: string;
  let binDir: string;
  let statusFile: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "tailscale-integration-"));
    binDir = path.join(home, "bin");
    statusFile = path.join(home, "status.json");
    await fs.mkdir(binDir, { recursive: true });

    const tailscaled = path.join(binDir, "tailscaled");
    await fs.writeFile(tailscaled, `#!/usr/bin/env node
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
if (!process.argv.includes("--state=mem:")) process.exit(42);
const arg = process.argv.find((value) => value.startsWith("--socket="));
const socket = arg.slice("--socket=".length);
fs.mkdirSync(path.dirname(socket), { recursive: true });
try { fs.unlinkSync(socket); } catch {}
const server = net.createServer(() => {});
server.listen(socket);
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`, { mode: 0o755 });

    const tailscale = path.join(binDir, "tailscale");
    await fs.writeFile(tailscale, `#!/bin/sh
set -eu
case " $* " in
  *" status --json "*) cat "$FAKE_TAILSCALE_STATUS_FILE" ;;
  *" ping "*) echo "pong from fake-tailnet" ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });

    await fs.writeFile(statusFile, JSON.stringify({
      BackendState: "Running",
      CurrentTailnet: { Name: "example.ts.net" },
      Self: { HostName: "opencode-bot", TailscaleIPs: ["100.64.0.2"], Online: true, Tags: ["tag:opencode-bot"] },
      Peer: {
        ssh: { HostName: "github-exit", DNSName: "github-exit.example.ts.net.", TailscaleIPs: ["100.64.0.10"], Online: true, Tags: ["tag:exit", "tag:ssh"] },
        normal: { HostName: "phone", TailscaleIPs: ["100.64.0.11"], Online: true, Tags: [] },
        offline: { HostName: "old-vps", TailscaleIPs: ["100.64.0.12"], Online: false, Tags: ["tag:ssh"] },
      },
    }));

    vi.stubEnv("OPENCODE_TELEGRAM_HOME", home);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:test-bot-token");
    vi.stubEnv("TELEGRAM_ALLOWED_USER_ID", "1");
    vi.stubEnv("TAILSCALE_BIN", tailscale);
    vi.stubEnv("TAILSALED_BIN", tailscaled);
    vi.stubEnv("FAKE_TAILSCALE_STATUS_FILE", statusFile);
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const service = await import("../../../src/app/services/tailscale-integration-service.js");
      await service.stopTailscaleIntegration();
    } catch {}
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("stores the Tailnet auth key encrypted and reports connected runtime state", async () => {
    const service = await import("../../../src/app/services/tailscale-integration-service.js");
    await service.configureTailscale("tskey-auth-super-secret");

    const raw = await fs.readFile(path.join(home, "app-state.json"), "utf8");
    expect(raw).toContain('"tailscale"');
    expect(raw).not.toContain("tskey-auth-super-secret");

    const status = await service.getTailscaleRuntimeStatus();
    expect(status).toEqual(expect.objectContaining({
      configured: true,
      connected: true,
      hostname: "opencode-bot",
      tailnet: "example.ts.net",
      selfTags: ["tag:opencode-bot"],
      visiblePeers: 3,
      sshDevices: 2,
    }));
  });

  it("reports every visible peer and explains SSH eligibility", async () => {
    const service = await import("../../../src/app/services/tailscale-integration-service.js");
    await service.configureTailscale("tskey-auth-test");

    const devices = await service.listTailscaleDevices();
    expect(devices.map((device) => device.name)).toEqual(["github-exit", "old-vps", "phone"]);
    expect(devices.find((device) => device.name === "github-exit")).toEqual(expect.objectContaining({
      sshEligible: true,
      sshReason: "eligible",
    }));
    expect(devices.find((device) => device.name === "phone")).toEqual(expect.objectContaining({
      sshEligible: false,
      sshReason: "missing-tag:ssh",
    }));
    expect(devices.find((device) => device.name === "old-vps")).toEqual(expect.objectContaining({
      sshEligible: false,
      sshReason: "offline",
    }));

    const sshDevices = await service.listTailscaleSshDevices();
    expect(sshDevices.map((device) => device.name)).toEqual(["github-exit", "old-vps"]);
  });

  it("rejects untagged and offline peers as SSH targets", async () => {
    const service = await import("../../../src/app/services/tailscale-integration-service.js");
    await service.configureTailscale("tskey-auth-test");

    await expect(service.resolveTailscaleSshDevice("phone")).rejects.toThrow(/tag:ssh/i);
    await expect(service.resolveTailscaleSshDevice("old-vps")).rejects.toThrow(/offline/i);
    await expect(service.resolveTailscaleSshDevice("github-exit")).resolves.toEqual(expect.objectContaining({
      name: "github-exit",
      online: true,
      tags: expect.arrayContaining(["tag:ssh"]),
    }));
  });

  it("uses container-local memory state instead of persisting a Tailscale node key", async () => {
    const service = await import("../../../src/app/services/tailscale-integration-service.js");
    await service.configureTailscale("tskey-auth-reusable");

    await expect(fs.stat(path.join(home, "tailscale", "tailscaled.state"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.getTailscaleSocketPath()).toBe("/tmp/opencode-tailscale/tailscaled.sock");
  });

});
