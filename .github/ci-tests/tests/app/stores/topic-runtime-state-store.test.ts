import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeMode } from "../../../src/runtime/mode.js";
import {
  __resetTopicRuntimeStatesForTests,
  ensureTopicRuntimeStateSync,
  getTopicRuntimeState,
  loadTopicRuntimeStates,
} from "../../../src/app/stores/topic-runtime-state-store.js";

describe("topic-runtime-state-store streaming mode migration", () => {
  let tempHome: string;
  let storeFile: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "opencode-topic-runtime-"));
    process.env.OPENCODE_TELEGRAM_HOME = tempHome;
    setRuntimeMode("installed");
    storeFile = path.join(tempHome, "runtime", "topics", "telegram-topic-runtime.json");
    await mkdir(path.dirname(storeFile), { recursive: true });
    __resetTopicRuntimeStatesForTests();
  });

  afterEach(async () => {
    __resetTopicRuntimeStatesForTests();
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("migrates legacy Topic edit streaming to draft and defaults new Topics to draft", async () => {
    await writeFile(storeFile, JSON.stringify([{
      chatId: 101,
      threadId: 202,
      settings: { responseStreamingMode: "edit", runState: "idle", updatedAt: "2026-10-16T00:00:00.000Z" },
    }]));

    await loadTopicRuntimeStates();
    expect((await getTopicRuntimeState(101, 202))?.settings.responseStreamingMode).toBe("draft");
    expect(ensureTopicRuntimeStateSync(101, 203).settings.responseStreamingMode).toBe("draft");
  });

  it("keeps an intentional edit choice after the migration marker is set", async () => {
    await writeFile(storeFile, JSON.stringify([{
      chatId: 101,
      threadId: 202,
      responseStreamingModeVersion: 1,
      settings: { responseStreamingMode: "edit", runState: "idle", updatedAt: "2026-10-16T00:00:00.000Z" },
    }]));

    await loadTopicRuntimeStates();
    expect((await getTopicRuntimeState(101, 202))?.settings.responseStreamingMode).toBe("edit");
  });
});
