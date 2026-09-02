import { afterEach, describe, expect, it, vi } from "vitest";
import { validateRailwayToken } from "../../../src/app/services/railway-integration-service.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("validateRailwayToken", () => {
  it("accepts an account token from the Railway GraphQL API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { me: { name: "Amin", email: "amin@example.com" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateRailwayToken("account-secret")).resolves.toEqual({
      valid: true,
      tokenType: "account",
      subjectName: "Amin",
      subjectEmail: "amin@example.com",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: "Bearer account-secret",
      "Content-Type": "application/json",
    });
  });

  it("accepts a project token using Railway's Project-Access-Token header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "Not Authorized" }] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { projectToken: { projectId: "project-123", environmentId: "env-456" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateRailwayToken("project-secret")).resolves.toEqual({
      valid: true,
      tokenType: "project",
      projectId: "project-123",
      environmentId: "env-456",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      "Project-Access-Token": "project-secret",
      "Content-Type": "application/json",
    });
  });

  it("rejects an unauthorized token without exposing its value", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "Not Authorized" }] }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateRailwayToken("do-not-log-me")).resolves.toEqual({ valid: false, reason: "unauthorized" });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("[REDACTED]");
  });
});
