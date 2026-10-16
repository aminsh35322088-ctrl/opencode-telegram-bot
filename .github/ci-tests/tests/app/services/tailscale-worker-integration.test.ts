import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Topic Worker Tailscale integration", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "tailscale-worker-integration-"));
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", home);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:test-bot-token");
    vi.stubEnv("TELEGRAM_USER_ID", "1");
    vi.stubEnv("DISTRIBUTED_CONTROL_ENABLED", "1");
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("stores and resolves the auth key without a local tailscaled socket", async () => {
    const service = await import("../../../src/app/services/tailscale-integration-service.js");

    await expect(service.configureTailscale("tskey-auth-worker-secret")).resolves.toBeUndefined();
    expect(await service.initializeTailscaleIntegration()).toBe(true);
    expect(await service.resolveTailscaleAuthKey("auth-key")).toBe("tskey-auth-worker-secret");
    expect(await service.resolveTailscaleAuthKey("other")).toBeNull();
    const status = await service.getTailscaleRuntimeStatus();
    expect(status).toEqual(expect.objectContaining({
      configured: true,
      connected: false,
      daemonRunning: false,
      executionScope: "topic-worker",
      hostname: "Topic Worker",
    }));

    const raw = await fs.readFile(path.join(home, "app-state.json"), "utf8");
    expect(raw).toContain('"tailscale"');
    expect(raw).not.toContain("tskey-auth-worker-secret");
  });

  it("rejects non-auth key types without storing the submitted value", async () => {
    const service = await import("../../../src/app/services/tailscale-integration-service.js");
    await expect(service.configureTailscale("tskey-client-not-an-auth-key"))
      .rejects.toThrow(/tskey-auth-/u);
    expect(await service.getTailscaleRuntimeStatus()).toEqual(expect.objectContaining({ configured: false }));
    await expect(fs.readFile(path.join(home, "app-state.json"), "utf8")).rejects.toThrow();
  });

  it("does not offer shared-daemon reconnect or disconnect operations", async () => {
    const service = await import("../../../src/app/services/tailscale-integration-service.js");
    await service.configureTailscale("tskey-auth-worker-secret");
    await expect(service.reconnectTailscale()).rejects.toThrow(/on demand/u);
    await expect(service.disconnectTailscale()).rejects.toThrow(/on demand/u);
  });
});
