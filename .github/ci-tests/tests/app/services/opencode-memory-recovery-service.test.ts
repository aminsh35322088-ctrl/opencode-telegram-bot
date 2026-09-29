import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  limit: vi.fn(),
  total: vi.fn(),
  workingSet: vi.fn(),
  idleMaintenance: vi.fn(),
  restart: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock("@opencode-telegram/native-runtime", () => ({
  RailwayResourceGovernor: {
    serviceMemoryLimitBytes: mocked.limit,
    serviceMemoryBytes: mocked.total,
    serviceWorkingSetBytes: mocked.workingSet,
  },
}));

vi.mock("../../../src/core/native-core-service.js", () => ({
  runCoreIdleMaintenance: mocked.idleMaintenance,
}));

vi.mock("../../../src/opencode/auto-restart.js", () => ({
  opencodeAutoRestartService: {
    restartForMemoryReclaim: mocked.restart,
  },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    info: mocked.loggerInfo,
    warn: mocked.loggerWarn,
    debug: mocked.loggerDebug,
  },
}));

describe("OpenCode memory recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    mocked.limit.mockReset().mockReturnValue(1_000);
    mocked.total.mockReset().mockReturnValue(900);
    mocked.workingSet.mockReset().mockReturnValue(800);
    mocked.restart.mockReset().mockResolvedValue(true);
    mocked.idleMaintenance.mockReset().mockImplementation(
      async (_reason: string, task: () => Promise<boolean>) => task(),
    );
    mocked.loggerInfo.mockReset();
    mocked.loggerWarn.mockReset();
    mocked.loggerDebug.mockReset();
  });

  it("recycles OpenCode through the Core idle-maintenance fence", async () => {
    const { recoverIdleOpenCodeMemory } = await import(
      "../../../src/app/services/opencode-memory-recovery-service.js"
    );

    await expect(recoverIdleOpenCodeMemory("prompt_admission", true)).resolves.toBe(true);

    expect(mocked.idleMaintenance).toHaveBeenCalledWith(
      "railway_memory_reclaim",
      expect.any(Function),
    );
    expect(mocked.restart).toHaveBeenCalledWith("prompt_admission");
    expect(mocked.loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("reclaimed idle OpenCode"),
    );
  });

  it("does not recycle for ordinary low pressure", async () => {
    mocked.total.mockReturnValue(700);
    mocked.workingSet.mockReturnValue(600);
    const { recoverIdleOpenCodeMemory } = await import(
      "../../../src/app/services/opencode-memory-recovery-service.js"
    );

    await expect(recoverIdleOpenCodeMemory("interval")).resolves.toBe(false);
    expect(mocked.idleMaintenance).not.toHaveBeenCalled();
    expect(mocked.restart).not.toHaveBeenCalled();
  });

  it("does not interrupt active Core work when the maintenance fence refuses", async () => {
    mocked.idleMaintenance.mockResolvedValue(false);
    const { recoverIdleOpenCodeMemory } = await import(
      "../../../src/app/services/opencode-memory-recovery-service.js"
    );

    await expect(recoverIdleOpenCodeMemory("prompt_admission", true)).resolves.toBe(false);
    expect(mocked.restart).not.toHaveBeenCalled();
  });
});
