import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const entrypoint = fs.readFileSync(path.join(repoRoot, "railway-entrypoint.sh"), "utf8");
const envExample = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
const lockPath = path.join(repoRoot, "rustdesk-bridge.lock");
const bridgeLock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : "";

describe("Railway bundled RustDesk runtime contract", () => {
  it("does not require user-managed RustDesk Railway variables", () => {
    expect(envExample).not.toMatch(/^RUSTDESK_BRIDGE_(?:URL|TOKEN|CONTROL_TOKEN)=/m);
    expect(entrypoint).not.toContain("${RUSTDESK_BRIDGE_URL:-");
    expect(entrypoint).not.toContain("${RUSTDESK_BRIDGE_TOKEN:-");
    expect(entrypoint).not.toContain("${RUSTDESK_BRIDGE_CONTROL_TOKEN:-");
  });

  it("runs the bridge on loopback with persistent state and internal credentials", () => {
    expect(entrypoint).toContain("RUSTDESK_BRIDGE_URL=http://127.0.0.1:21119");
    expect(entrypoint).toContain("RUSTDESK_BRIDGE_BIND=127.0.0.1:21119");
    expect(entrypoint).toContain("/data/rustdesk/config.json");
    expect(entrypoint).toContain("/data/rustdesk/identity");
    expect(entrypoint).toContain("/data/rustdesk/audit/audit.jsonl");
    expect(entrypoint).toMatch(/RUSTDESK_BRIDGE_TOKEN=.*urandom/);
    expect(entrypoint).toMatch(/RUSTDESK_BRIDGE_CONTROL_TOKEN=.*urandom/);
  });

  it("bootstraps a checksum-pinned private Core release through the existing GitHub integration", () => {
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(bridgeLock).toContain("bridge-contract-v3-43cce2c-bookworm-x86_64");
    expect(bridgeLock).toContain("43cce2c4d26fb045ea31cee53c82de9cd2d0e54c");
    expect(bridgeLock).toContain("ca12ca7cb0433f432344741632c7a5baa2525a2632e371c6fc76aae13ad49c12");
    expect(bridgeLock).toContain("RUSTDESK_BRIDGE_CONTRACT_VERSION=3");
    expect(dockerfile).toContain("rustdesk-bridge.lock");
    expect(dockerfile).toContain("libyuv0");
    expect(dockerfile).toContain("libgstreamer-plugins-base1.0-0");
    expect(bridgeLock).toContain("aminsh35322088-ctrl/RustDesk-Core-Lab");
    expect(entrypoint).toContain("gh release download");
    expect(entrypoint).toContain("sha256sum -c");
    expect(entrypoint).toContain("/data/bin/rustdesk-controller-bridge");
    expect(entrypoint).toContain("/health");
    expect(entrypoint).toContain("contractVersion");
  });
});
