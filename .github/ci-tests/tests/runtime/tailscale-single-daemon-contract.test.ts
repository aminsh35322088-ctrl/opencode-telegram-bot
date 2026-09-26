import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Railway Tailscale single-daemon contract", () => {
  it("starts exactly one persistent userspace daemon from the entrypoint", () => {
    const entrypoint = fs.readFileSync("railway-entrypoint.sh", "utf8");
    const launches = entrypoint.match(/\/usr\/local\/bin\/tailscaled\b/g) ?? [];
    expect(launches).toHaveLength(1);
    expect(entrypoint).toContain("--tun=userspace-networking");
    expect(entrypoint).toContain("--state='$TAILSCALE_STATE'");
    expect(entrypoint).toContain('TAILSCALE_STATE_DIR="/data/tailscale"');
    expect(entrypoint).toContain('TAILSCALE_STATE="$TAILSCALE_STATE_DIR/tailscaled.state"');
    expect(entrypoint).toContain('TAILSCALE_SOCKET="/data/run/tailscale/tailscaled.sock"');
    expect(entrypoint).not.toContain("--state=mem:");
  });

  it("keeps application code as a client of the shared daemon", () => {
    const service = fs.readFileSync("src/app/services/tailscale-integration-service.ts", "utf8");
    expect(service).not.toContain("spawn(");
    expect(service).not.toContain("TAILSALED_BIN");
    expect(service).toContain('/data/run/tailscale/tailscaled.sock');
    expect(service).toContain('tailscale set --hostname failed');
  });

  it("documents a reusable non-ephemeral key for stable machine identity", () => {
    const integrations = fs.readFileSync("src/bot/commands/integrations-command.ts", "utf8");
    expect(integrations).toContain("Reusable: ON");
    expect(integrations).toContain("Ephemeral: OFF");
    expect(integrations).toContain("tag:opencode-bot");
    expect(integrations).toContain("persistent node identity");
  });
});
