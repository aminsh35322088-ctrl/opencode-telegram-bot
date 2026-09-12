import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_BASE_URL,
  verifyOpenRouterApiKey,
} from "../../../src/app/services/openrouter-provider-service.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter API key verification", () => {
  it("verifies the key against OpenRouter's authenticated current-key endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { is_management_key: false, is_provisioning_key: false } }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyOpenRouterApiKey("  sk-or-v1-valid  ")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${OPENROUTER_BASE_URL}/key`,
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-or-v1-valid" },
      }),
    );
  });

  it("rejects invalid credentials without persisting them", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => "Unauthorized",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyOpenRouterApiKey("bad-key")).rejects.toThrow(
      "OpenRouter API key verification failed: HTTP 401",
    );
  });

  it("rejects management or provisioning keys because they are not inference keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { is_management_key: true, is_provisioning_key: false } }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyOpenRouterApiKey("management-key")).rejects.toThrow(
      "regular OpenRouter inference API key",
    );
  });

  it("rejects an empty key before making a network request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyOpenRouterApiKey("   ")).rejects.toThrow("OpenRouter API key is empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
