import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentAction } from "../../../src/app/services/agent-action-registry.js";

/**
 * PR #121 added a direct SSH client with Cloudflare Access transport.
 * Those artifacts were fully removed; this contract keeps them gone.
 *
 * Pre-existing and intentionally kept:
 * - openssh-client system package (Git-over-SSH)
 * - `.ssh` sensitive-path segment (artifact upload guard)
 * - Cloudflare Workers AI image provider (predates PR #121)
 */

const FORBIDDEN_PATHS = [
  ".opencode/tools/ssh.ts",
  "docs/CLOUDFLARE_SSH.md",
  "src/app/services/cloudflare-integration-service.ts",
  "src/app/services/ssh-identity-service.ts",
  ".github/ci-tests/tests/app/services/cloudflare-integration-service.test.ts",
  ".github/ci-tests/tests/app/services/ssh-tool-contract.test.ts",
] as const;

const FORBIDDEN_TOKENS = [
  "Cloudflare Access",
  "cloudflared",
  "CLOUDFLARED",
  "ssh-identity",
  "SshIdentity",
] as const;

const SCAN_ROOTS = ["src", "docs", ".opencode", "railway-entrypoint.sh", "Dockerfile", "opencode.json"] as const;

const SSH_ACTION_IDS = [
  "ssh.status",
  "ssh.key.ensure",
  "ssh.key.public",
  "ssh.exec",
  "ssh.read",
  "ssh.write",
  "ssh.upload",
  "ssh.download",
] as const;

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

describe("PR #121 SSH and Cloudflare Access absence contract", () => {
  it("does not ship any PR #121 artifact paths", () => {
    for (const relative of FORBIDDEN_PATHS) {
      expect(existsSync(repoPath(relative)), `${relative} must not exist`).toBe(false);
    }
  });

  it("does not contain PR #121-only tokens in source, docs, tools, or runtime entrypoints", () => {
    const files = SCAN_ROOTS.flatMap((root) => walkFiles(repoPath(root)));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      if (!/\.(ts|tsx|js|mjs|cjs|json|md|sh|toml|yml|yaml)$/i.test(file) && path.basename(file) !== "Dockerfile") {
        continue;
      }
      const source = readFileSync(file, "utf8");
      for (const token of FORBIDDEN_TOKENS) {
        expect(source.includes(token), `${path.relative(process.cwd(), file)} must not contain ${token}`).toBe(false);
      }
    }
  });

  it("does not register any ssh.* agent actions", () => {
    for (const id of SSH_ACTION_IDS) {
      expect(getAgentAction(id), id).toBeNull();
    }
  });

  it("keeps the custom tool surface free of an ssh tool", () => {
    const toolsDir = repoPath(path.join(".opencode", "tools"));
    const tools = readdirSync(toolsDir).filter((name) => name.endsWith(".ts"));
    expect(tools).not.toContain("ssh.ts");
  });
});
