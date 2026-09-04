import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

const mocked = vi.hoisted(() => ({
  healthMock: vi.fn(),
  resolveLocalOpencodeTargetMock: vi.fn(),
  startLocalOpencodeServerMock: vi.fn(),
  notifyReadyMock: vi.fn(),
  notifyUnavailableMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  config: {
    opencode: {
      apiUrl: "http://localhost:4096",
      autoRestartEnabled: false,
      monitorIntervalSec: 300,
    },
  },
}));

vi.mock("../../src/config.js", () => ({ config: mocked.config }));
vi.mock("../../src/opencode/client.js", () => ({ opencodeClient: { global: { health: mocked.healthMock } } }));
vi.mock("../../src/opencode/process.js", () => ({
  resolveLocalOpencodeTarget: mocked.resolveLocalOpencodeTargetMock,
  startLocalOpencodeServer: mocked.startLocalOpencodeServerMock,
}));
vi.mock("../../src/opencode/ready-lifecycle.js", () => ({
  opencodeReadyLifecycle: {
    notifyReady: mocked.notifyReadyMock,
    notifyUnavailable: mocked.notifyUnavailableMock,
  },
}));
vi.mock("../../src/utils/logger.js", () => ({
  logger: {
    debug: mocked.loggerDebugMock,
    info: mocked.loggerInfoMock,
    warn: mocked.loggerWarnMock,
    error: mocked.loggerErrorMock,
  },
}));

import { OpencodeAutoRestartService } from "../../src/opencode/auto-restart.js";

function createChildProcess(pid: number): ChildProcess {
  return { pid, once: vi.fn(), unref: vi.fn() } as unknown as ChildProcess;
}

function healthyResponse() {
  return { data: { healthy: true, version: "1.2.3" }, error: null };
}

describe("opencode/auto-restart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocked.healthMock.mockReset();
    mocked.resolveLocalOpencodeTargetMock.mockReset();
    mocked.startLocalOpencodeServerMock.mockReset();
    mocked.notifyReadyMock.mockReset();
    mocked.notifyUnavailableMock.mockReset();
    mocked.loggerDebugMock.mockReset();
    mocked.loggerInfoMock.mockReset();
    mocked.loggerWarnMock.mockReset();
    mocked.loggerErrorMock.mockReset();

    mocked.config.opencode.apiUrl = "http://localhost:4096";
    mocked.config.opencode.autoRestartEnabled = false;
    mocked.config.opencode.monitorIntervalSec = 300;
    mocked.resolveLocalOpencodeTargetMock.mockReturnValue({ host: "localhost", port: 4096 });
    mocked.startLocalOpencodeServerMock.mockReturnValue(createChildProcess(123));
    mocked.notifyReadyMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("does nothing when auto-restart is disabled", async () => {
    const service = new OpencodeAutoRestartService();
    await service.start();
    expect(mocked.resolveLocalOpencodeTargetMock).not.toHaveBeenCalled();
    expect(mocked.healthMock).not.toHaveBeenCalled();
    expect(mocked.startLocalOpencodeServerMock).not.toHaveBeenCalled();
  });

  it("does not start a process for remote OpenCode URLs", async () => {
    mocked.config.opencode.autoRestartEnabled = true;
    mocked.config.opencode.apiUrl = "https://example.com";
    mocked.resolveLocalOpencodeTargetMock.mockReturnValue(null);
    const service = new OpencodeAutoRestartService();
    await service.start();
    expect(mocked.resolveLocalOpencodeTargetMock).toHaveBeenCalledWith("https://example.com");
    expect(mocked.healthMock).not.toHaveBeenCalled();
    expect(mocked.startLocalOpencodeServerMock).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("OPENCODE_API_URL is not local"));
  });

  it("starts the local server immediately when the startup health-check fails", async () => {
    mocked.config.opencode.autoRestartEnabled = true;
    mocked.healthMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(healthyResponse());
    const childProcess = createChildProcess(321);
    mocked.startLocalOpencodeServerMock.mockReturnValue(childProcess);
    const service = new OpencodeAutoRestartService();

    await service.start();

    expect(mocked.healthMock).toHaveBeenCalledTimes(2);
    expect(mocked.startLocalOpencodeServerMock).toHaveBeenCalledTimes(1);
    expect(childProcess.unref).toHaveBeenCalledTimes(1);
    expect(mocked.notifyUnavailableMock).not.toHaveBeenCalled();
    expect(mocked.notifyReadyMock).toHaveBeenCalledWith("auto_restart_startup");
    expect(mocked.loggerWarnMock).not.toHaveBeenCalledWith(expect.stringContaining("consecutiveFailures=1/2"));
    expect(mocked.loggerWarnMock).not.toHaveBeenCalledWith(expect.stringContaining("consecutiveFailures=2/2"));

    service.stop();
  });

  it("does not spawn a local process in a container when startup spawn is disabled", async () => {
    mocked.config.opencode.autoRestartEnabled = true;
    vi.stubEnv("OPENCODE_TELEGRAM_CONTAINER", "1");
    mocked.healthMock.mockRejectedValueOnce(new Error("offline"));
    const service = new OpencodeAutoRestartService();

    await service.start();

    expect(mocked.healthMock).toHaveBeenCalledTimes(1);
    expect(mocked.startLocalOpencodeServerMock).not.toHaveBeenCalled();
    expect(mocked.notifyUnavailableMock).not.toHaveBeenCalled();
    expect(mocked.loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("local spawn is disabled in this container"),
    );

    service.stop();
  });

  it("does not start a process when the server is already healthy", async () => {
    mocked.config.opencode.autoRestartEnabled = true;
    mocked.healthMock.mockResolvedValue(healthyResponse());
    const service = new OpencodeAutoRestartService();

    await service.start();

    expect(mocked.healthMock).toHaveBeenCalledTimes(1);
    expect(mocked.startLocalOpencodeServerMock).not.toHaveBeenCalled();
    expect(mocked.notifyReadyMock).toHaveBeenCalledWith("auto_restart_startup");

    service.stop();
  });

  it("does not refresh cache on every healthy interval", async () => {
    mocked.config.opencode.autoRestartEnabled = true;
    mocked.config.opencode.monitorIntervalSec = 300;
    mocked.healthMock.mockResolvedValue(healthyResponse());
    const service = new OpencodeAutoRestartService();

    await service.start();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(mocked.healthMock).toHaveBeenCalledTimes(2);
    expect(mocked.notifyReadyMock).toHaveBeenCalledTimes(1);

    service.stop();
  });

  it("restarts after two consecutive runtime health-check failures", async () => {
    mocked.config.opencode.autoRestartEnabled = true;
    mocked.healthMock
      .mockResolvedValueOnce(healthyResponse())
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(healthyResponse());
    const service = new OpencodeAutoRestartService();

    await service.start();
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(mocked.startLocalOpencodeServerMock).toHaveBeenCalledTimes(1);
    expect(mocked.notifyUnavailableMock).toHaveBeenCalledWith("auto_restart_interval");
    expect(mocked.notifyReadyMock).toHaveBeenCalledTimes(2);

    service.stop();
  });

  it("does not run overlapping checks", async () => {
    mocked.config.opencode.autoRestartEnabled = true;
    mocked.config.opencode.monitorIntervalSec = 1;
    mocked.healthMock.mockResolvedValueOnce(healthyResponse());
    const service = new OpencodeAutoRestartService();
    await service.start();

    let resolveHealth: (value: ReturnType<typeof healthyResponse>) => void = () => undefined;
    const pendingHealth = new Promise<ReturnType<typeof healthyResponse>>((resolve) => {
      resolveHealth = resolve;
    });
    mocked.healthMock.mockImplementationOnce(() => pendingHealth);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocked.healthMock).toHaveBeenCalledTimes(2);

    mocked.healthMock.mockResolvedValueOnce(healthyResponse());
    resolveHealth(healthyResponse());
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocked.startLocalOpencodeServerMock).not.toHaveBeenCalled();

    service.stop();
  });
});
