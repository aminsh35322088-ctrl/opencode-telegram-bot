import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({
  health: vi.fn(),
  spawn: vi.fn(),
  find: vi.fn(),
  kill: vi.fn(),
  container: true,
}));
vi.mock("../../src/config.js", () => ({
  config: {
    opencode: { autoRestartEnabled: true, apiUrl: "http://localhost:4096", monitorIntervalSec: 1 },
  },
}));
vi.mock("../../src/runtime/container.js", () => ({ isContainerRuntime: () => deps.container }));
vi.mock("../../src/opencode/client.js", () => ({
  opencodeClient: { global: { health: deps.health } },
}));
vi.mock("../../src/opencode/process.js", () => ({
  resolveLocalOpencodeTarget: () => ({ host: "localhost", port: 4096 }),
  startLocalOpencodeServer: deps.spawn,
  findServerPid: deps.find,
  killServerProcess: deps.kill,
}));
vi.mock("../../src/opencode/ready-lifecycle.js", () => ({
  opencodeReadyLifecycle: { notifyReady: vi.fn(), notifyUnavailable: vi.fn() },
}));
vi.mock("../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { OpencodeAutoRestartService } from "../../src/opencode/auto-restart.js";
function child(pid = 123) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    unref: vi.fn(),
  }) as unknown as ChildProcess;
}
let service: OpencodeAutoRestartService;
let core: ChildProcess;
let exit: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCODE_AUTO_START_IN_CONTAINER", "true");
  deps.container = true;
  core = child();
  exit = vi.fn();
  service = new OpencodeAutoRestartService(exit);
  deps.spawn.mockReset().mockResolvedValue(core);
  deps.find.mockReset().mockResolvedValue(null);
  deps.kill.mockReset().mockResolvedValue(true);
  deps.health.mockReset().mockResolvedValue({ data: { healthy: true } });
  deps.health.mockRejectedValueOnce(new Error("offline"));
});
afterEach(() => {
  service.stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it.each([
  [0, null],
  [1, null],
  [75, null],
  [null, "SIGKILL"],
] as const)("container unexpected exit %s/%s ends essential application", async (code, signal) => {
  await service.start();
  core.emit("exit", code, signal);
  await Promise.resolve();
  expect(exit).toHaveBeenCalledWith(75);
  expect(deps.spawn).toHaveBeenCalledTimes(1);
});
it("startup completion before listener installation fails closed", async () => {
  core.exitCode = 75;
  await service.start();
  expect(exit).toHaveBeenCalledWith(75);
  expect(deps.spawn).toHaveBeenCalledTimes(1);
});
it("spawn rejection ends essential application", async () => {
  deps.spawn.mockRejectedValue(new Error("spawn failed"));
  await service.start();
  expect(exit).toHaveBeenCalledWith(75);
});
it("shutdown cannot hide later child authority loss", async () => {
  await service.start();
  service.stop();
  core.emit("exit", null, "SIGKILL");
  expect(exit).toHaveBeenCalledWith(75);
});
it("planned replacement requires joined normal exit0", async () => {
  await service.start();
  deps.find.mockResolvedValue(123);
  deps.kill.mockImplementation(async () => {
    core.emit("exit", 0, null);
    return true;
  });
  deps.spawn.mockResolvedValue(child(124));
  expect(await service.restartForConfigChange("test")).toBe(true);
  expect(exit).not.toHaveBeenCalled();
  expect(deps.spawn).toHaveBeenCalledTimes(2);
});
it.each([
  [75, null],
  [null, "SIGKILL"],
] as const)("planned retirement %s/%s cannot replace Core", async (code, signal) => {
  await service.start();
  deps.find.mockResolvedValue(123);
  deps.kill.mockImplementation(async () => {
    core.emit("exit", code, signal);
    return true;
  });
  expect(await service.restartForMemoryReclaim("test")).toBe(false);
  expect(exit).toHaveBeenCalledWith(75);
  expect(deps.spawn).toHaveBeenCalledTimes(1);
});
it("unconfirmed retirement fails closed even when listener kill reports success", async () => {
  await service.start();
  deps.find.mockResolvedValue(123);
  const restart = service.restartForConfigChange("test");
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await restart).toBe(false);
  expect(exit).toHaveBeenCalledWith(75);
  expect(deps.spawn).toHaveBeenCalledTimes(1);
});
it("unknown startup listener cannot be replaced", async () => {
  deps.find.mockResolvedValue(456);
  await service.start();
  expect(exit).toHaveBeenCalledWith(75);
  expect(deps.spawn).not.toHaveBeenCalled();
});
it("container health failure does not authorize forced replacement", async () => {
  await service.start();
  deps.health.mockRejectedValue(new Error("unhealthy"));
  await vi.advanceTimersByTimeAsync(3_000);
  expect(exit).toHaveBeenCalledWith(75);
  expect(deps.spawn).toHaveBeenCalledTimes(1);
});
it("desktop retains unexpected-exit recovery", async () => {
  deps.container = false;
  await service.start();
  core.emit("exit", 1, null);
  await vi.advanceTimersByTimeAsync(0);
  expect(exit).not.toHaveBeenCalled();
  expect(deps.spawn).toHaveBeenCalledTimes(2);
});
it("spawn without a PID cannot be treated as ready", async () => {
  core.pid = undefined;
  await service.start();
  expect(exit).toHaveBeenCalledWith(75);
});
it("retirement errors end essential application", async () => {
  await service.start();
  deps.find.mockResolvedValue(123);
  deps.kill.mockRejectedValue(new Error("cannot stop"));
  expect(await service.restartForConfigChange("test")).toBe(false);
  expect(exit).toHaveBeenCalledWith(75);
  expect(deps.spawn).toHaveBeenCalledTimes(1);
});
it("exit during readiness cannot publish recovered Core", async () => {
  deps.health.mockReset();
  deps.health.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  deps.health.mockImplementationOnce(async () => {
    core.emit("exit", 75, null);
    return { data: { healthy: true } };
  });
  expect(await service.start()).toBe(false);
  expect(exit).toHaveBeenCalledWith(75);
});
