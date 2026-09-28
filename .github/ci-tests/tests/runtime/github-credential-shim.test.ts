import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The entrypoint materializes a `gh` shim and a git credential helper so the
 * model-facing tools authenticate through the bot-managed GitHub integration.
 *
 * The active token is not stored in app-state.json: it lives in the Credential
 * Vault and reaches those scripts through the environment the bot process
 * exports. These tests pin that contract, because losing it silently turns
 * every git/gh call into an unauthenticated request.
 */

const INHERITED_TOKEN = "ghp_shimcontract0000000000000000000000000";
const LEGACY_STATE_TOKEN = "ghp_legacystate00000000000000000000000000";

function extractHeredoc(source: string, marker: RegExp): string {
  const match = source.match(marker);
  if (!match?.[1]) throw new Error(`heredoc not found for ${marker}`);
  return match[1];
}

function writeState(dir: string, account: Record<string, unknown>): string {
  const stateFile = path.join(dir, "app-state.json");
  writeFileSync(
    stateFile,
    JSON.stringify({ integrations: { github: { activeId: account.id, accounts: [account] } } }),
  );
  return stateFile;
}

/** Mirrors what the bot persists today: no plaintext token, only a credentialId. */
function vaultOnlyAccount() {
  return {
    id: "amin-github",
    name: "Amin-GitHub",
    username: "aminsh35322088-ctrl",
    tokenFile: "",
    credentialId: "token",
    createdAt: "2026-09-28T10:17:49.243Z",
  };
}

describe("Railway entrypoint GitHub credential shims", () => {
  const source = readFileSync(path.join(process.cwd(), "railway-entrypoint.sh"), "utf8");

  function buildShims(dir: string): { gh: string; helper: string } {
    const stub = path.join(dir, "gh-stub");
    writeFileSync(stub, '#!/bin/sh\nprintf "TOKEN=[%s]\\n" "${GH_TOKEN:-<empty>}"\n');
    chmodSync(stub, 0o755);

    const gh = path.join(dir, "gh");
    writeFileSync(
      gh,
      extractHeredoc(source, /cat > "\$INTEGRATION_BIN_DIR\/gh" <<'EOF'\n([\s\S]*?)\nEOF\n/)
        // The shim hardcodes its gh config dir under /data, which a CI runner
        // cannot create. Redirect it into the sandbox: the behaviour under test
        // is token propagation, not where gh keeps its config.
        .replaceAll("/data/.config/gh", path.join(dir, "gh-config"))
        .replace("/usr/bin/gh", stub),
    );
    chmodSync(gh, 0o755);

    const helper = path.join(dir, "github-credential-helper.sh");
    writeFileSync(
      helper,
      `#!/bin/sh\n${extractHeredoc(
        source,
        /cat > \/data\/run\/github-credential-helper\.sh <<'EOF'\n([\s\S]*?)\nEOF\n/,
      )}\n`,
    );
    chmodSync(helper, 0o755);

    return { gh, helper };
  }

  function run(dir: string, script: string, args: string[], env: NodeJS.ProcessEnv, input?: string): string {
    return execFileSync("sh", [script, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", OPENCODE_TELEGRAM_HOME: dir, ...env },
      input,
    });
  }

  function sandbox(): string {
    return mkdtempSync(path.join(os.tmpdir(), "gh-shim-"));
  }

  it("keeps an inherited vault-resolved token instead of dropping it", () => {
    const dir = sandbox();
    writeState(dir, vaultOnlyAccount());
    const { gh } = buildShims(dir);

    const out = run(dir, gh, ["api", "user"], { GH_TOKEN: INHERITED_TOKEN, GITHUB_TOKEN: INHERITED_TOKEN });

    expect(out.trim()).toBe(`TOKEN=[${INHERITED_TOKEN}]`);
  });

  it("answers the git credential prompt from the inherited token", () => {
    const dir = sandbox();
    writeState(dir, vaultOnlyAccount());
    const { helper } = buildShims(dir);

    const out = run(dir, helper, ["get"], { GH_TOKEN: INHERITED_TOKEN }, "protocol=https\nhost=github.com\n\n");

    expect(out).toContain("username=x-access-token");
    expect(out).toContain(`password=${INHERITED_TOKEN}`);
  });

  it("falls back to GITHUB_TOKEN when GH_TOKEN is absent", () => {
    const dir = sandbox();
    writeState(dir, vaultOnlyAccount());
    const { helper } = buildShims(dir);

    const out = run(dir, helper, ["get"], { GITHUB_TOKEN: INHERITED_TOKEN }, "protocol=https\n\n");

    expect(out).toContain(`password=${INHERITED_TOKEN}`);
  });

  it("prefers a legacy plaintext state token when one is still present", () => {
    const dir = sandbox();
    writeState(dir, { ...vaultOnlyAccount(), id: "legacy", token: LEGACY_STATE_TOKEN });
    const { gh, helper } = buildShims(dir);

    expect(run(dir, gh, ["api", "user"], { GH_TOKEN: INHERITED_TOKEN }).trim()).toBe(
      `TOKEN=[${LEGACY_STATE_TOKEN}]`,
    );
    expect(run(dir, helper, ["get"], { GH_TOKEN: INHERITED_TOKEN }, "protocol=https\n\n")).toContain(
      `password=${LEGACY_STATE_TOKEN}`,
    );
  });

  it("stays fail-closed and silent when no token exists anywhere", () => {
    const dir = sandbox();
    writeState(dir, vaultOnlyAccount());
    const { gh, helper } = buildShims(dir);

    expect(run(dir, gh, ["api", "user"], {}).trim()).toBe("TOKEN=[<empty>]");
    expect(run(dir, helper, ["get"], {}, "protocol=https\n\n")).toBe("");
  });

  it("survives a missing or malformed state file", () => {
    const dir = sandbox();
    const { gh, helper } = buildShims(dir);

    writeFileSync(path.join(dir, "app-state.json"), "not json at all");
    expect(run(dir, gh, ["api", "user"], {}).trim()).toBe("TOKEN=[<empty>]");
    expect(run(dir, helper, ["get"], {}, "protocol=https\n\n")).toBe("");
  });
});

describe("Orbit entrypoint GitHub credential shims", () => {
  const source = readFileSync(path.join(process.cwd(), "orbit-entrypoint.sh"), "utf8");

  function buildShims(dir: string): { gh: string; helper: string } {
    const stub = path.join(dir, "gh-stub");
    writeFileSync(stub, '#!/bin/sh\nprintf "TOKEN=[%s]\\n" "${GH_TOKEN:-<empty>}"\n');
    chmodSync(stub, 0o755);

    const gh = path.join(dir, "gh-orbit");
    writeFileSync(
      gh,
      extractHeredoc(source, /cat > "\$INTEGRATION_BIN_DIR\/gh" <<'EOF_GH'\n([\s\S]*?)\nEOF_GH\n/),
    );
    chmodSync(gh, 0o755);

    const helper = path.join(dir, "github-credential-helper-orbit.sh");
    writeFileSync(
      helper,
      `#!/bin/sh\n${extractHeredoc(
        source,
        /cat > "\$STATE_ROOT\/run\/github-credential-helper\.sh" <<'EOF_CRED'\n([\s\S]*?)\nEOF_CRED\n/,
      )}\n`,
    );
    chmodSync(helper, 0o755);

    return { gh, helper };
  }

  function run(dir: string, script: string, env: NodeJS.ProcessEnv, input?: string): string {
    return execFileSync("sh", [script, "api", "user"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        OPENCODE_TELEGRAM_HOME: dir,
        ORBIT_REAL_GH_BIN: path.join(dir, "gh-stub"),
        ...env,
      },
      input,
    });
  }

  it("keeps an inherited vault-resolved token instead of dropping it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gh-shim-orbit-"));
    writeFileSync(
      path.join(dir, "app-state.json"),
      JSON.stringify({
        integrations: { github: { activeId: "amin-github", accounts: [vaultOnlyAccount()] } },
      }),
    );
    const { gh } = buildShims(dir);

    expect(run(dir, gh, { GH_TOKEN: INHERITED_TOKEN }).trim()).toBe(`TOKEN=[${INHERITED_TOKEN}]`);
  });

  it("answers the git credential prompt from the inherited token", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gh-shim-orbit-"));
    const { helper } = buildShims(dir);

    expect(run(dir, helper, { GH_TOKEN: INHERITED_TOKEN }, "protocol=https\n\n")).toContain(
      `password=${INHERITED_TOKEN}`,
    );
  });

  it("stays fail-closed and silent when no token exists anywhere", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gh-shim-orbit-"));
    const { gh, helper } = buildShims(dir);

    expect(run(dir, gh, {}).trim()).toBe("TOKEN=[<empty>]");
    expect(run(dir, helper, {}, "protocol=https\n\n")).toBe("");
  });
});
