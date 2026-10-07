import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeMode } from "../../../src/runtime/mode.js";
import {
  readAppState,
  resetAppStateForFactory,
  updateAppState,
} from "../../../src/app/stores/app-state-store.js";

describe("canonical app-state factory reset", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "app-state-factory-reset-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    setRuntimeMode("installed");
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("preserves monotonic Global revision while purging user state and allows later writes", async () => {
    await updateAppState({
      settings: { theme: "dark" },
      integrations: { github: { token: "must-disappear" } },
    });
    const before = await readAppState();
    const beforeRevision = (before.globalSnapshot as { revision: number }).revision;

    await resetAppStateForFactory();

    const reset = await readAppState();
    expect(reset.settings).toBeUndefined();
    expect(reset.integrations).toBeUndefined();
    expect((reset.globalSnapshot as { revision: number }).revision).toBeGreaterThan(beforeRevision);
    await expect(fs.stat(path.join(home, "app-state.json.bak"))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(updateAppState({ settings: { theme: "light" } })).resolves.toBeUndefined();
    const after = await readAppState();
    expect((after.settings as { theme?: string }).theme).toBe("light");
    expect((after.globalSnapshot as { revision: number }).revision).toBeGreaterThanOrEqual(
      (reset.globalSnapshot as { revision: number }).revision,
    );
  });
});
