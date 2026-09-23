import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mockedAppState = vi.hoisted(() => ({
  readAppState: vi.fn(),
  updateAppState: vi.fn(),
}));

vi.mock("../../../src/app/stores/app-state-store.js", () => ({
  readAppState: mockedAppState.readAppState,
  updateAppState: mockedAppState.updateAppState,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../src/runtime/paths.js", () => ({
  getRuntimePaths: () => ({ appHome: process.env.OPENCODE_TELEGRAM_HOME ?? os.tmpdir() }),
}));

import { syncOpenCodeCustomConfig } from "../../../src/app/services/custom-provider-service.js";

describe("custom-provider config sync boot path", () => {
  let home: string;
  let originalHome: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "custom-provider-sync-"));
    originalHome = process.env.OPENCODE_TELEGRAM_HOME;
    process.env.OPENCODE_TELEGRAM_HOME = home;

    let store = {
      providers: [
        {
          id: "slow-provider",
          name: "Slow Provider",
          baseURL: "https://slow.example/v1",
          apiKey: "sk-test",
          capability: "general",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          models: [
            {
              id: "agent-model",
              name: "Agent Model",
              toolCall: true,
              toolCallVerified: false,
              modalities: { input: ["text"], output: ["text"] },
            },
          ],
        },
      ],
    };

    mockedAppState.readAppState.mockReset();
    mockedAppState.readAppState.mockResolvedValue({ customProviders: store });
    mockedAppState.updateAppState.mockReset();
    mockedAppState.updateAppState.mockImplementation(async (patch: unknown) => {
      const fn = patch as (state: unknown) => Record<string, unknown>;
      const result = fn({ customProviders: store });
      if (result.customProviders) store = result.customProviders as typeof store;
    });

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.OPENCODE_TELEGRAM_HOME;
    else process.env.OPENCODE_TELEGRAM_HOME = originalHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("writes the fail-closed config without waiting for tool-call probes", async () => {
    const result = await Promise.race([
      syncOpenCodeCustomConfig(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);

    expect(result).not.toBe("timeout");
    expect(typeof result).toBe("string");
    const written = await fs.readFile(result as string, "utf8");
    expect(written).toContain("slow-provider");
    // Unverified model must stay fail-closed in the immediately written config.
    expect(written).toContain('"tool_call": false');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never starts tool-call probes during config sync", async () => {
    const configPath = await syncOpenCodeCustomConfig();

    expect(typeof configPath).toBe("string");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
