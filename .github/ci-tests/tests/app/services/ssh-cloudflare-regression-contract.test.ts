import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentAction } from "../../../src/app/services/agent-action-registry.js";

/**
 * PR #121's Cloudflare Access/direct-identity implementation remains removed.
 * SSH has since returned as a new profile-scoped Tailscale/direct subsystem,
 * so this regression contract protects the old removals without forbidding
 * the new SSH surface.
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

const REQUIRED_SSH_ACTIONS = [
  "ssh.tailnet.status",
  "ssh.tailnet.ping",
  "ssh.profiles.list",
  "ssh.profiles.get",
  "ssh.profiles.create",
  "ssh.profiles.update",
  "ssh.profiles.delete",
  "ssh.credentials.status",
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

  it("requires the new profile-scoped SSH action surface", () => {
    for (const id of REQUIRED_SSH_ACTIONS) expect(getAgentAction(id), id).not.toBeNull();
    expect(existsSync(repoPath(".opencode/tools/ssh.ts"))).toBe(true);
  });

  it("keeps the SSH tool permission-gated", () => {
    const config = JSON.parse(readFileSync(repoPath("opencode.json"), "utf8")) as {
      permission?: Record<string, unknown>;
    };
    expect(config.permission?.ssh).toBe("ask");
  });
});
