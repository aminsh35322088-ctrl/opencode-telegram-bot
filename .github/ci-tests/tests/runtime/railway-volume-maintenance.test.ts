import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = fs.readFileSync(
  path.join(process.cwd(), "railway-volume-maintenance.sh"),
  "utf8",
);

describe("Railway volume emergency maintenance", () => {
  it("reclaims rebuildable artifacts before attempting git gc", () => {
    expect(script).toContain(
      'CRITICAL_MB="${OPENCODE_DATA_VOLUME_CRITICAL_MB:-100}"',
    );
    expect(script).toContain("Critical free space");
    expect(script).toContain('$DATA_ROOT/.cache');
    expect(script).toContain('$DATA_ROOT/run');
    expect(script).toContain(
      '$DATA_ROOT/.local/share/opencode/tool-output',
    );
    expect(script).toContain('$PERSISTENT_REPO/node_modules');
    expect(script).toContain("Emergency-trimmed OpenCode log");
    expect(script).toContain("tail -c 262144");
    expect(script).toContain("opencode-db-maintenance.mjs");

    const cleanupIndex = script.indexOf("Critical free space");
    const gcIndex = script.indexOf("compacting persistent Git repository");
    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(gcIndex).toBeGreaterThan(cleanupIndex);
  });

  it("does not target persistent user or credential state", () => {
    const destructiveLines = script
      .split("\n")
      .filter((line) => /rm\s+-rf|find .* -exec rm -rf/.test(line));

    const protectedPaths = [
      "app-state.json",
      "opencode.db",
      "topic-workspaces",
      "/data/workspace",
      "/data/.config",
      "sessions",
    ];

    for (const line of destructiveLines) {
      for (const protectedPath of protectedPaths) {
        expect(line).not.toContain(protectedPath);
      }
    }
  });
});
