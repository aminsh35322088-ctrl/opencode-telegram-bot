import { describe, expect, it } from "vitest";
import {
  ProcessBudgetError,
  ProcessBudgetGovernor,
  type ServiceResourceSnapshot,
} from "../../src/runtime/process-budget.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function resources(
  memoryUsedBytes = 512 * MiB,
  memoryLimitBytes: number | null = GiB,
): () => Promise<ServiceResourceSnapshot> {
  return async () => ({
    memoryUsedBytes,
    memoryLimitBytes,
    memoryPressure: memoryLimitBytes ? memoryUsedBytes / memoryLimitBytes : null,
    cpuLimitCores: 2,
  });
}

describe("ProcessBudgetGovernor", () => {
  it("enforces singleton local MCP admission and releases capacity", async () => {
    const governor = new ProcessBudgetGovernor(7, resources());
    const first = await governor.acquire("mcp-server");

    await expect(governor.acquire("mcp-server")).rejects.toMatchObject({
      name: "ProcessBudgetError",
      kind: "mcp-server",
      reason: "category_limit",
    });

    first.release();
    const second = await governor.acquire("mcp-server");
    expect(second.kind).toBe("mcp-server");
    second.release();
  });

  it("rejects new heavy work before cgroup memory headroom is exhausted", async () => {
    const governor = new ProcessBudgetGovernor(7, resources(900 * MiB, GiB));

    await expect(governor.acquire("media")).rejects.toMatchObject({
      name: "ProcessBudgetError",
      kind: "media",
      reason: "memory_pressure",
    } satisfies Partial<ProcessBudgetError>);
  });

  it("prevents overlapping OpenCode servers when the predicted footprint would exceed the service limit", async () => {
    const governor = new ProcessBudgetGovernor(7, resources(800 * MiB, GiB));

    await expect(governor.acquire("opencode-server")).rejects.toMatchObject({
      name: "ProcessBudgetError",
      kind: "opencode-server",
      reason: "memory_pressure",
    } satisfies Partial<ProcessBudgetError>);
  });

  it("caps requested timeouts to the rule maximum", async () => {
    const governor = new ProcessBudgetGovernor(7, resources());
    const lease = await governor.acquire("ssh", 60 * 60_000);

    expect(lease.timeoutMs).toBe(10 * 60_000);
    lease.release();
  });

  it("enforces a global process ceiling across categories", async () => {
    const governor = new ProcessBudgetGovernor(2, resources());
    const ssh = await governor.acquire("ssh");
    const tailscale = await governor.acquire("tailscale");

    await expect(governor.acquire("diagnostic")).rejects.toMatchObject({
      name: "ProcessBudgetError",
      reason: "global_limit",
    });

    ssh.release();
    tailscale.release();
  });

  it("reserves category capacity before the asynchronous resource probe completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    const governor = new ProcessBudgetGovernor(7, async () => {
      reads += 1;
      await gate;
      return await resources()();
    });

    const first = governor.acquire("media");
    await Promise.resolve();

    await expect(governor.acquire("media")).rejects.toMatchObject({
      name: "ProcessBudgetError",
      reason: "category_limit",
    });

    release();
    const lease = await first;
    expect(reads).toBe(1);
    lease.release();
  });

  it("keeps cleanup admission available under global and memory pressure", async () => {
    const governor = new ProcessBudgetGovernor(1, resources(1020 * MiB, GiB));
    const first = await governor.acquire("cleanup");
    const second = await governor.acquire("cleanup");

    expect(first.kind).toBe("cleanup");
    expect(second.kind).toBe("cleanup");

    first.release();
    second.release();
  });

  it("reports active leases by process kind", async () => {
    const governor = new ProcessBudgetGovernor(7, resources());
    const first = await governor.acquire("ssh");
    const second = await governor.acquire("tailscale");

    const snapshot = await governor.snapshot();
    expect(snapshot.activeCount).toBe(2);
    expect(snapshot.activeByKind).toEqual({
      ssh: 1,
      tailscale: 1,
    });
    expect(snapshot.memoryLimitBytes).toBe(GiB);
    expect(snapshot.cpuLimitCores).toBe(2);

    first.release();
    second.release();
    expect((await governor.snapshot()).activeCount).toBe(0);
  });
});
