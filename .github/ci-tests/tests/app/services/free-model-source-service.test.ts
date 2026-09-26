import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFreeSourceProviderConfigs,
  buildOmniEnvironment,
  cancelFreebuffAutoConnect,
  checkFreebuffAutoConnect,
  getPendingFreebuffAutoConnect,
  startFreebuffAutoConnect,
  type FreeModelSourceID,
} from "../../../src/app/services/free-model-source-service.js";

describe("experimental free model source config", () => {
  afterEach(() => {
    cancelFreebuffAutoConnect();
    vi.unstubAllGlobals();
  });

  it("builds five isolated OpenAI-compatible providers over one local runtime", () => {
    const configured = new Set<FreeModelSourceID>(["ds", "freebuff"]);
    const sources = buildFreeSourceProviderConfigs({
      gemini: ["gemini-3.6-flash"],
      qwen: ["qwen3.8-max"],
      glm: ["glm-5.3-flash"],
      ds: ["deepseek-chat"],
      freebuff: ["z-ai/glm-5.3-flash"],
    }, configured);

    expect(sources.map((source) => source.id)).toEqual([
      "experimental-gemini-web",
      "experimental-qwen-web",
      "experimental-glm-web",
      "experimental-deepseek-web",
      "experimental-freebuff",
    ]);

    for (const source of sources) {
      expect(source.config).toMatchObject({
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "http://127.0.0.1:8790/v1",
          apiKey: "{env:OPENCODE_TELEGRAM_OMNI_ROUTER_KEY}",
        },
      });
    }

    const geminiModels = sources[0]!.config.models as Record<string, any>;
    expect(geminiModels["gemini/gemini-3.6-flash"]).toMatchObject({
      attachment: true,
      tool_call: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    });

    const qwenModels = sources[1]!.config.models as Record<string, any>;
    expect(qwenModels["qwen/qwen3.8-max"]).toMatchObject({
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
    });

    const freebuffModels = sources[4]!.config.models as Record<string, unknown>;
    expect(freebuffModels).toHaveProperty("freebuff/z-ai/glm-5.3-flash");
    expect(String(sources[3]!.config.name)).toContain("Account connected");
    expect(String(sources[2]!.config.name)).toContain("Connect required");
  });

  it("does not leak unrelated bot process secrets into the OmniRouter child", () => {
    process.env.TELEGRAM_BOT_TOKEN = "should-not-leak";
    process.env.GITHUB_TOKEN = "should-not-leak";
    process.env.SSL_CERT_FILE = "/tmp/ca.pem";
    try {
      const env = buildOmniEnvironment(
        { deepseekToken: "ds-secret" },
        "/tmp/omni-data",
        "sk-router",
        "internal-secret",
        "admin-secret",
      );
      expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.DEEPSEEK_TOKENS).toBe("ds-secret");
      expect(env.ROUTER_KEY).toBe("sk-router");
      expect(env.AUTH_TOKEN).toBe("internal-secret");
      expect(env.SSL_CERT_FILE).toBe("/tmp/ca.pem");
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.SSL_CERT_FILE;
    }
  });

  it("starts the official Freebuff browser login and treats 401 status as pending", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        loginUrl: "https://freebuff.com/login?code=abc",
        fingerprintHash: "hash-1",
        expiresAt: 123456,
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "pending" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const started = await startFreebuffAutoConnect();
    expect(started.loginUrl).toBe("https://freebuff.com/login?code=abc");
    expect(getPendingFreebuffAutoConnect()?.loginUrl).toBe(started.loginUrl);

    const result = await checkFreebuffAutoConnect();
    expect(result).toMatchObject({ status: "pending", loginUrl: started.loginUrl });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/auth/cli/status?");
  });

  it("rejects an unexpected Freebuff login origin", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      loginUrl: "https://evil.example/login",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(startFreebuffAutoConnect()).rejects.toThrow("unexpected login origin");
    expect(getPendingFreebuffAutoConnect()).toBeNull();
  });

  it("can expose only sources that passed runtime usability checks", () => {
    const sources = buildFreeSourceProviderConfigs({
      gemini: ["gemini-3.6-flash"],
      qwen: ["qwen3.8-max"],
      glm: ["glm-5.3-flash"],
      ds: ["deepseek-chat"],
      freebuff: ["z-ai/glm-5.3-flash"],
    }, new Set<FreeModelSourceID>(), new Set<FreeModelSourceID>(["gemini"]));

    expect(sources.map((source) => source.id)).toEqual(["experimental-gemini-web"]);
  });

  it("uses source-specific conservative catalogs when discovery is empty", () => {
    const sources = buildFreeSourceProviderConfigs({});
    const byID = new Map(sources.map((source) => [source.id, source.config.models as Record<string, unknown>]));

    expect(Object.keys(byID.get("experimental-gemini-web")!)).toContain("gemini/gemini-3.6-flash");
    expect(Object.keys(byID.get("experimental-qwen-web")!)).toContain("qwen/qwen3.8-max");
    expect(Object.keys(byID.get("experimental-glm-web")!)).toContain("glm/glm-5.3-flash");
    expect(Object.keys(byID.get("experimental-deepseek-web")!)).toContain("ds/deepseek-chat");
    expect(Object.keys(byID.get("experimental-freebuff")!)).toContain("freebuff/z-ai/glm-5.3-flash");
  });
});
