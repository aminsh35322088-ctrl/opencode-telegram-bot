import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentAction } from "../../../src/app/services/agent-action-registry.js";

/**
 * PR #121's Cloudflare Access/direct-identity implementation remains removed.
 * SSH has since returned as a Tailscale-only subsystem. This regression
 * contract protects the old Cloudflare/direct-identity removal while requiring
 * the new Tailnet-only action surface.
 */

const LEGACY_FORBIDDEN_PATHS = [
  "docs/CLOUDFLARE_SSH.md",
  "src/app/services/cloudflare-integration-service.ts",
  "src/app/services/ssh-identity-service.ts",
  ".github/ci-tests/tests/app/services/cloudflare-integration-service.test.ts",
  ".github/ci-tests/tests/app/services/ssh-tool-contract.test.ts",
] as const;

const LEGACY_FORBIDDEN_TOKENS = [
  "Cloudflare Access",
  "cloudflared",
  "CLOUDFLARED",
  "ssh-identity",
  "SshIdentity",
] as const;

const LEGACY_FORBIDDEN_ACTIONS = [
  "ssh.status",
  "ssh.key.ensure",
  "ssh.key.public",
  "ssh.read",
  "ssh.write",
] as const;

const REQUIRED_REMOTE_ACTIONS = [
  "tailscale.status",
  "tailscale.devices",
  "tailscale.ping",
  "ssh.check",
  "ssh.debug",
  "ssh.exec",
  "ssh.upload",
  "ssh.download",
] as const;

const SCAN_ROOTS = ["src", "docs", ".opencode", "railway-entrypoint.sh", "Dockerfile", "opencode.json"] as const;

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const stats = statSync(root);
  if (stats.isFile()) return [root];
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    files.push(...walkFiles(path.join(root, entry)));
  }
  return files;
}

function repoPath(relative: string): string {
  return path.join(process.cwd(), relative);
}

describe("SSH/Cloudflare regression contract", () => {
  it("keeps the removed PR #121 Cloudflare artifacts absent", () => {
    for (const relative of LEGACY_FORBIDDEN_PATHS) {
      expect(existsSync(repoPath(relative)), `${relative} must not exist`).toBe(false);
    }

    const files = SCAN_ROOTS.flatMap((root) => walkFiles(repoPath(root)));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      if (!/\.(ts|tsx|js|mjs|cjs|json|md|sh|toml|yml|yaml)$/i.test(file) && path.basename(file) !== "Dockerfile") continue;
      const source = readFileSync(file, "utf8");
      for (const token of LEGACY_FORBIDDEN_TOKENS) {
        expect(source.includes(token), `${path.relative(process.cwd(), file)} must not contain ${token}`).toBe(false);
      }
    }
  });

  it("keeps obsolete PR #121 SSH action IDs gone", () => {
    for (const id of LEGACY_FORBIDDEN_ACTIONS) expect(getAgentAction(id), id).toBeNull();
  });

  it("requires the new Tailnet-only remote action surface", () => {
    for (const id of REQUIRED_REMOTE_ACTIONS) expect(getAgentAction(id), id).not.toBeNull();
    expect(existsSync(repoPath(".opencode/tools/ssh.ts"))).toBe(true);
    expect(existsSync(repoPath(".opencode/tools/tailscale.ts"))).toBe(true);
    expect(existsSync(repoPath("src/app/services/ssh-profile-store.ts"))).toBe(false);
    expect(existsSync(repoPath("src/app/services/ssh-credential-store.ts"))).toBe(false);
  });

  it("keeps SSH authorization independent from ControlMaster liveness", () => {
    const source = readFileSync(repoPath(".opencode/tools/ssh.ts"), "utf8");
    expect(source).toContain("hasTailnetSshAuthorization");
    expect(source).toContain("grantTailnetSshAuthorization");
    expect(source).toContain("allowConnectionStart: authorizationLease");
    expect(source).toContain("automatic master recovery");
  });
  it("keeps the SSH tool permission-gated", () => {
    const config = JSON.parse(readFileSync(repoPath("opencode.json"), "utf8")) as {
      permission?: Record<string, unknown>;
    };
    expect(config.permission?.ssh).toBe("allow");
    expect(config.permission?.["ssh-remote"]).toBe("ask");
    expect(config.permission?.tailscale).toBe("allow");
  });
});
