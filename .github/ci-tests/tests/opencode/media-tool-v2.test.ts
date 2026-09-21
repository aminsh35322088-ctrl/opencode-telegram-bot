import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";

describe("media tool Image AI V2 contract", () => {
  it("uses the configured image action service instead of deleted legacy image-topic code", async () => {
    const source = await fs.readFile(".opencode/tools/media.ts", "utf8");
    expect(source).toContain("generateConfiguredImage");
    expect(source).toContain("editConfiguredImage");
    expect(source).toContain("context.worktree");
    expect(source).not.toContain("image-chat-engine");
    expect(source).not.toContain("image-chat-profile-service");
    expect(source).not.toContain("runImageChatEngine");
  });
});
