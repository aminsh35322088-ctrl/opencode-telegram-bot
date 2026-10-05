import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Railway entrypoint repository bootstrap", () => {
  const source = readFileSync(path.join(process.cwd(), "railway-entrypoint.sh"), "utf8");

  it("materializes the persistent source checkout from Railway Git metadata", () => {
    expect(source).toContain('PERSISTENT_REPO_DIR="/data/opencode/opencode-telegram-bot"');
    expect(source).toContain("RAILWAY_GIT_REPO_OWNER");
    expect(source).toContain("RAILWAY_GIT_REPO_NAME");
    expect(source).toContain("RAILWAY_GIT_COMMIT_SHA");
    expect(source).toContain('BOOTSTRAP_GIT_TIMEOUT_SEC="${BOOTSTRAP_GIT_TIMEOUT_SEC:-120}"');
    expect(source).toContain('BOOTSTRAP_PROBE_TIMEOUT_SEC="${BOOTSTRAP_PROBE_TIMEOUT_SEC:-5}"');
    expect(source).toContain("git clone --filter=blob:none --no-tags");
    expect(source).toContain('timeout "${BOOTSTRAP_GIT_TIMEOUT_SEC}s" /bin/sh -c "git clone');
    expect(source).toContain("git -C \'$PERSISTENT_REPO_DIR\' fetch --prune origin");
    expect(source).toContain('timeout "${BOOTSTRAP_GIT_TIMEOUT_SEC}s" /bin/sh -c "git -C');
    expect(source).toContain("Persistent repository checkout ready");
    expect(source).toContain('timeout "${BOOTSTRAP_PROBE_TIMEOUT_SEC}s" /bin/sh -c "git -C');
  });

  it("bounds startup version probes so tool discovery cannot stall the service", () => {
    expect(source).toContain('timeout "${BOOTSTRAP_PROBE_TIMEOUT_SEC}s" /bin/sh -c \'opencode --version\'');
    expect(source).toContain('timeout "${BOOTSTRAP_PROBE_TIMEOUT_SEC}s" playwright-cli --version');
    expect(source).toContain('timeout "${BOOTSTRAP_PROBE_TIMEOUT_SEC}s" node --version');
    expect(source).toContain('timeout "${BOOTSTRAP_PROBE_TIMEOUT_SEC}s" /usr/bin/gh --version');
  });

  it("cleans untracked persistent checkout artifacts before OpenCode uses it", () => {
    expect(source).toContain("git -C '$PERSISTENT_REPO_DIR' clean -ffd");
  });

  it("removes the retired OmniRouter runtime without content-scanning user data", () => {
    expect(source).toContain("rm -rf /data/omnirouter");
    expect(source).not.toContain("QwenDiag|experimental-qwen-web|omnirouter|free-model-source");
    expect(source).not.toContain("find \"$root\" -type f");
    expect(source).not.toContain("rm -rf /data/.config/opencode");
    expect(source).not.toContain("rm -rf /data/workspace/.opencode");
  });

  it("does not hardcode this repository owner/name into the bootstrap", () => {
    expect(source).not.toContain("aminsh35322088-ctrl/opencode-telegram-bot.git");
  });
});
