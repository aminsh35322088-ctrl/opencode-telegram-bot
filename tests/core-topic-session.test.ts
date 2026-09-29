import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInTopicRuntimeContext } from "../src/app/services/topic-runtime-context.js";
import {
  getCurrentSession,
  getEffectiveCurrentSession,
} from "../src/app/services/session-service.js";
import {
  __resetSettingsForTests,
  clearSession,
  flushSettings,
  setCurrentSession,
} from "../src/app/stores/settings-store.js";

test("an unbound Topic cannot inherit the global session", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "core-topic-test-"));
  const previousHome = process.env.OPENCODE_TELEGRAM_HOME;
  process.env.OPENCODE_TELEGRAM_HOME = home;
  __resetSettingsForTests();
  try {
    setCurrentSession({ id: "global", title: "Global", directory: "/global" });
    assert.equal(getCurrentSession()?.id, "global");
    await runInTopicRuntimeContext({ chatId: 1, threadId: 2 }, async () => {
      assert.equal(getCurrentSession(), null);
      assert.equal(await getEffectiveCurrentSession(), null);
    });
  } finally {
    clearSession();
    await flushSettings();
    __resetSettingsForTests();
    if (previousHome === undefined) delete process.env.OPENCODE_TELEGRAM_HOME;
    else process.env.OPENCODE_TELEGRAM_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
