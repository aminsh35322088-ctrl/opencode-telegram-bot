import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  saveCustomProvider: vi.fn(),
  syncOpenCodeCustomConfig: vi.fn(),
  findServerPid: vi.fn(),
  killServerProcess: vi.fn(),
  resolveLocalOpencodeTarget: vi.fn(),
  startLocalOpencodeServer: vi.fn(),
  reconcileStoredModelSelection: vi.fn(),
  waitForOpencodeReadyAndRefresh: vi.fn(),
}));

vi.mock("../../../src/app/services/custom-provider-service.js", () => ({
  saveCustomProvider: mocked.saveCustomProvider,
  syncOpenCodeCustomConfig: mocked.syncOpenCodeCustomConfig,
}));

vi.mock("../../../src/config.js", () => ({
  config: { opencode: { apiUrl: "http://127.0.0.1:4096" } },
}));

vi.mock("../../../src/opencode/process.js", () => ({
  findServerPid: mocked.findServerPid,
  killServerProcess: mocked.killServerProcess,
  resolveLocalOpencodeTarget: mocked.resolveLocalOpencodeTarget,
  startLocalOpencodeServer: mocked.startLocalOpencodeServer,
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  reconcileStoredModelSelection: mocked.reconcileStoredModelSelection,
}));

vi.mock("../../../src/opencode/ready-refresh.js", () => ({
  waitForOpencodeReadyAndRefresh: mocked.waitForOpencodeReadyAndRefresh,
}));

import { verifyAndSaveGeminiChatProvider } from "../../../src/app/services/gemini-chat-service.js";

describe("gemini chat provider restart integration", () => {
  beforeEach(() => {
    mocked.saveCustomProvider.mockReset().mockResolvedValue(undefined);
    mocked.syncOpenCodeCustomConfig.mockReset().mockResolvedValue("/tmp/opencode.json");
    mocked.findServerPid.mockReset().mockResolvedValue(null);
    mocked.killServerProcess.mockReset().mockResolvedValue(true);
    mocked.resolveLocalOpencodeTarget.mockReset().mockReturnValue({ host: "127.0.0.1", port: 4096 });
    mocked.startLocalOpencodeServer.mockReset().mockReturnValue({ unref: vi.fn() });
    mocked.reconcileStoredModelSelection.mockReset().mockResolvedValue(undefined);
    mocked.waitForOpencodeReadyAndRefresh.mockReset().mockResolvedValue(true);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores secure MCP runtime state after Gemini restarts local OpenCode", async () => {
    await verifyAndSaveGeminiChatProvider("gemini-secret");

    expect(mocked.startLocalOpencodeServer).toHaveBeenCalledTimes(1);
    expect(mocked.waitForOpencodeReadyAndRefresh).toHaveBeenCalledWith("gemini_provider_change");
  });
});
