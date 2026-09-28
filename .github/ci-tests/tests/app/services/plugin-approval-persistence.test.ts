import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: { token: "123456:plugin-approval-persistence", allowedUserId: 1 },
    opencode: {
      apiUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "",
      autoRestartEnabled: false,
      monitorIntervalSec: 20,
      model: { provider: "opencode", modelId: "test-model" },
    },
  },
}));

const reloadManagedOpenCodeConfig = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../../../src/app/services/opencode-managed-config-service.js", () => ({
  reloadManagedOpenCodeConfig,
}));

vi.mock("../../../src/app/services/skills-catalog-service.js", () => ({
  loadSkillsCatalog: vi.fn().mockResolvedValue([]),
}));

import {
  approveExtensionEnsure,
  cancelExtensionEnsure,
  findPendingExtensionEnsure,
  getExtensionEnsureRequest,
  requestExtensionEnsure,
} from "../../../src/app/services/extension-ensure-service.js";
import { listStoredExtensions } from "../../../src/app/services/extension-store.js";
import type { ExtensionEnsureRequest } from "../../../src/app/types/extension.js";

const SPECIFIER = "superpowers@git+https://github.com/obra/superpowers.git#v6.4.2";

/**
 * Plugin approval requests are created by the OpenCode server process (the bot
 * tool executes there) and consumed by the Telegram bot process. These tests
 * exercise the persistence boundary rather than a process-local Map, which is
 * what previously made the approval card impossible to deliver.
 */
describe("plugin approval request persistence across processes", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-approval-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function request(sessionId = "ses_1"): Promise<{ requestId: string }> {
    const result = await requestExtensionEnsure({
      sessionId,
      projectDirectory: home,
      name: "superpowers",
      kind: "plugin",
      source: SPECIFIER,
      purpose: "Reusable planning/debugging/testing skills.",
    });
    expect(result.status).toBe("approval-required");
    return result as { requestId: string };
  }

  it("makes an awaiting request readable by session for the presenting process", async () => {
    const { requestId } = await request("ses_alpha");
    // Simulates a different process: nothing in memory carries over, only disk.
    const pending = findPendingExtensionEnsure("ses_alpha");
    expect(pending?.id).toBe(requestId);
    expect(pending).toMatchObject({ name: "superpowers", status: "awaiting-approval" });
    expect(getExtensionEnsureRequest(requestId)?.source).toBe(SPECIFIER);
  });

  it("does not leak a request to another session", async () => {
    await request("ses_alpha");
    expect(findPendingExtensionEnsure("ses_beta")).toBeNull();
  });

  it("claims the request exactly once so a double tap cannot install twice", async () => {
    const { requestId } = await request();
    const first = await approveExtensionEnsure(requestId);
    expect(first.status).toBe("ready");
    expect(first.extension.resource).toEqual({ kind: "plugin", specifier: SPECIFIER });

    await expect(approveExtensionEnsure(requestId)).rejects.toThrow(/expired/);
    expect(reloadManagedOpenCodeConfig).toHaveBeenCalledTimes(1);
    expect((await listStoredExtensions()).map((item) => item.id)).toEqual(["plugin:superpowers"]);
  });

  it("records a terminal failure instead of leaving a stale approvable request", async () => {
    const { requestId } = await request();
    reloadManagedOpenCodeConfig.mockRejectedValueOnce(new Error("OpenCode rejected the managed config reload."));

    await expect(approveExtensionEnsure(requestId)).rejects.toThrow(/rejected/);
    expect(getExtensionEnsureRequest(requestId)).toBeNull();
    expect(findPendingExtensionEnsure("ses_1")).toBeNull();

    // The record is rolled back so no half-installed extension survives.
    expect(await listStoredExtensions()).toEqual([]);
    const persisted = JSON.parse(
      await fs.readFile(
        path.join(home, "run", "extension-automation", "ensure-requests", `${requestId}.json`),
        "utf8",
      ),
    ) as ExtensionEnsureRequest;
    expect(persisted).toMatchObject({ status: "failed" });
  });

  it("cancels a pending request and makes it undiscoverable", async () => {
    const { requestId } = await request();
    expect(cancelExtensionEnsure(requestId)).toBe(true);
    expect(findPendingExtensionEnsure("ses_1")).toBeNull();
    expect(cancelExtensionEnsure(requestId)).toBe(false);
  });

  it("expires a request past its TTL", async () => {
    const { requestId } = await request();
    const file = path.join(home, "run", "extension-automation", "ensure-requests", `${requestId}.json`);
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as ExtensionEnsureRequest;
    await fs.writeFile(file, JSON.stringify({ ...stored, expiresAt: Date.now() - 1 }));

    expect(getExtensionEnsureRequest(requestId)).toBeNull();
    expect(findPendingExtensionEnsure("ses_1")).toBeNull();
    await expect(approveExtensionEnsure(requestId)).rejects.toThrow(/expired/);
  });

  it("keeps concurrent requests from different sessions independently approvable", async () => {
    const first = await request("ses_alpha");
    const second = await request("ses_beta");
    expect(first.requestId).not.toBe(second.requestId);

    expect(findPendingExtensionEnsure("ses_alpha")?.id).toBe(first.requestId);
    expect(findPendingExtensionEnsure("ses_beta")?.id).toBe(second.requestId);

    await approveExtensionEnsure(first.requestId);
    expect(findPendingExtensionEnsure("ses_beta")?.id).toBe(second.requestId);
  });

  it("rejects a request id that could escape the state directory", () => {
    expect(cancelExtensionEnsure("../../escape")).toBe(false);
  });
});
