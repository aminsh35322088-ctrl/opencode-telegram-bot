import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateRailwayToken, addRailwayAccount, setActiveRailwayAccount, removeRailwayAccount, clearRailwayToken } from "../../../src/app/services/railway-integration-service.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("validateRailwayToken", () => {
  it("accepts an account token from the Railway GraphQL API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { me: { name: "Amin", email: "amin@example.com" } } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(validateRailwayToken("account-secret")).resolves.toEqual({ valid: true, tokenType: "account", subjectName: "Amin", subjectEmail: "amin@example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: "Bearer account-secret", "Content-Type": "application/json" });
  });

  it("accepts a project token using Railway's Project-Access-Token header", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "Not Authorized" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { projectToken: { projectId: "project-123", environmentId: "env-456" } } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(validateRailwayToken("project-secret")).resolves.toEqual({ valid: true, tokenType: "project", projectId: "project-123", environmentId: "env-456" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ "Project-Access-Token": "project-secret", "Content-Type": "application/json" });
  });

  it("accepts a workspace token with Authorization Bearer scope", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "Not Authorized" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "Not Authorized" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { projects: { edges: [{ node: { id: "project-123", name: "Bot" } }] } } }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(validateRailwayToken("workspace-secret")).resolves.toEqual({ valid: true, tokenType: "workspace" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({ Authorization: "Bearer workspace-secret", "Content-Type": "application/json" });
  });

  it("rejects an unauthorized token without exposing its value", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "Not Authorized" }] }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(validateRailwayToken("do-not-log-me")).resolves.toEqual({ valid: false, reason: "unauthorized" });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("[REDACTED]");
  });
});

describe("applyActiveRailwayToken env vars", () => {
  let home: string;
  const originalRailwayToken = process.env.RAILWAY_TOKEN;
  const originalApiToken = process.env.RAILWAY_API_TOKEN;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "railway-env-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    delete process.env.RAILWAY_TOKEN;
    delete process.env.RAILWAY_API_TOKEN;
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.OPENCODE_TELEGRAM_HOME;
    if (originalRailwayToken === undefined) delete process.env.RAILWAY_TOKEN; else process.env.RAILWAY_TOKEN = originalRailwayToken;
    if (originalApiToken === undefined) delete process.env.RAILWAY_API_TOKEN; else process.env.RAILWAY_API_TOKEN = originalApiToken;
  });

  it("sets RAILWAY_API_TOKEN for an account token after add", async () => {
    await addRailwayAccount("Amin", "account-secret", "account");
    expect(process.env.RAILWAY_API_TOKEN).toBe("account-secret");
    expect(process.env.RAILWAY_TOKEN).toBeUndefined();
  });

  it("sets RAILWAY_TOKEN for a project token after add", async () => {
    await addRailwayAccount("Proj", "project-secret", "project");
    expect(process.env.RAILWAY_TOKEN).toBe("project-secret");
    expect(process.env.RAILWAY_API_TOKEN).toBeUndefined();
  });

  it("switches env var when active account changes", async () => {
    await addRailwayAccount("Acct", "account-secret", "account");
    await addRailwayAccount("Proj", "project-secret", "project");
    await setActiveRailwayAccount("acct");
    expect(process.env.RAILWAY_API_TOKEN).toBe("account-secret");
    await setActiveRailwayAccount("proj");
    expect(process.env.RAILWAY_TOKEN).toBe("project-secret");
    expect(process.env.RAILWAY_API_TOKEN).toBeUndefined();
  });

  it("clears env vars when the last account is removed", async () => {
    await addRailwayAccount("Acct", "account-secret", "account");
    expect(process.env.RAILWAY_API_TOKEN).toBe("account-secret");
    await removeRailwayAccount("acct");
    expect(process.env.RAILWAY_API_TOKEN).toBeUndefined();
  });

  it("clears env vars on clearRailwayToken", async () => {
    await addRailwayAccount("Acct", "account-secret", "account");
    await clearRailwayToken();
    expect(process.env.RAILWAY_API_TOKEN).toBeUndefined();
    expect(process.env.RAILWAY_TOKEN).toBeUndefined();
  });
});
