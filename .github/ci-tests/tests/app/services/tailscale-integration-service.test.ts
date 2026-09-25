import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("bot-managed Tailscale integration", () => {
  let home: string;
  let binDir: string;
  let statusFile: string;
  let socketPath: string;
  let server: net.Server;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "tailscale-integration-"));
    binDir = path.join(home, "bin");
    statusFile = path.join(home, "status.json");
    socketPath = path.join(home, "run", "tailscaled.sock");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(path.dirname(socketPath), { recursive: true });

    server = net.createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

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
    vi.stubEnv("TAILSCALE_SOCKET", socketPath);
    vi.stubEnv("FAKE_TAILSCALE_STATUS_FILE", statusFile);
    vi.resetModules();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
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
      daemonRunning: true,
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

  it("never spawns its own daemon and requires the shared socket", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const service = await import("../../../src/app/services/tailscale-integration-service.js");
    await expect(service.ensureTailscaleDaemon()).rejects.toThrow(/shared tailscaled socket/i);
  });
});
