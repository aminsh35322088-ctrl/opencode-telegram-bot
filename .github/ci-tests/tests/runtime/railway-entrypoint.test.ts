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
    expect(source).toContain("git clone --filter=blob:none --no-tags");
    expect(source).toContain("git -C \'$PERSISTENT_REPO_DIR\' fetch --prune origin");
    expect(source).toContain("Persistent repository checkout ready");
  });

  it("cleans untracked persistent checkout artifacts before OpenCode uses it", () => {
    expect(source).toContain("git -C '$PERSISTENT_REPO_DIR' clean -ffd");
  });

  it("removes only retired OmniRouter/Qwen generated runtime artifacts", () => {
    expect(source).toContain("rm -rf /data/omnirouter");
    expect(source).toContain("QwenDiag|experimental-qwen-web|omnirouter|free-model-source");
    expect(source).toContain("/data/.local/share/opencode");
    expect(source).toContain("/data/workspace/.opencode/plugin");
    expect(source).toContain("/data/workspace/.opencode/tools");
    expect(source).not.toContain("rm -rf /data/.config/opencode");
    expect(source).not.toContain("rm -rf /data/workspace/.opencode");
  });

  it("does not hardcode this repository owner/name into the bootstrap", () => {
    expect(source).not.toContain("aminsh35322088-ctrl/opencode-telegram-bot.git");
  });
});
