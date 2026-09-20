import { Agent as HttpsAgent } from "https";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestInfo, RequestInit } from "node-fetch";
import {
  createTelegramBotOptions,
  resetTelegramFetchForTests,
  setTelegramFetchForTests,
  setTelegramRequestTimeoutForTests,
} from "../../src/bot/telegram-client-options.js";

function makeTelegramConfig(overrides: Partial<Parameters<typeof createTelegramBotOptions>[0]> = {}) {
  return {
    apiRoot: "",
    proxySecret: "",
    proxyUrl: "",
    forceIpv4: false,
    ...overrides,
  };
}

describe("createTelegramBotOptions", () => {
  afterEach(() => {
    resetTelegramFetchForTests();
  });
  it("always installs the bounded fetch wrapper, even for direct requests", () => {
    const options = createTelegramBotOptions(makeTelegramConfig());

    expect(options.client?.fetch).toBeTypeOf("function");
    expect(options.client?.baseFetchConfig).toBeUndefined();
  });

  it("configures an IPv4 HTTPS agent for direct Telegram API requests when enabled", () => {
    const options = createTelegramBotOptions(makeTelegramConfig({ forceIpv4: true }));
    const agent = options.client?.baseFetchConfig?.agent;

    expect(agent).toBeInstanceOf(HttpsAgent);
    expect((agent as HttpsAgent).options.family).toBe(4);
    expect(options.client?.baseFetchConfig?.compress).toBe(true);
  });

  it("keeps reverse-proxy options when IPv4 mode is enabled", () => {
    const options = createTelegramBotOptions(
      makeTelegramConfig({
        apiRoot: "https://tg-proxy.example.com",
        proxySecret: "secret-abc",
        forceIpv4: true,
      }),
    );

    expect(options.client?.apiRoot).toBe("https://tg-proxy.example.com");
    expect(options.client?.fetch).toBeTypeOf("function");
    expect(options.client?.baseFetchConfig?.agent).toBeInstanceOf(HttpsAgent);
  });

  it("keeps forward proxy wiring when IPv4 mode is also enabled", () => {
    const options = createTelegramBotOptions(
      makeTelegramConfig({
        proxyUrl: "https://proxy.example.com:8443",
        forceIpv4: true,
      }),
    );

    expect(options.client?.baseFetchConfig?.agent).not.toBeInstanceOf(HttpsAgent);
    expect(options.client?.baseFetchConfig?.compress).toBe(true);
  });

  it("bounds every Bot API request with a timeout except long-poll getUpdates", async () => {
    const options = createTelegramBotOptions(makeTelegramConfig());
    const fetch = options.client?.fetch;
    expect(fetch).toBeTypeOf("function");
    if (typeof fetch !== "function") return;

    const calls: Array<{ url: string; signal?: AbortSignal }> = [];
    const hangingFetch = (_url: RequestInfo, init?: RequestInit): Promise<unknown> => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      calls.push({ url: String(typeof _url === "string" ? _url : ""), signal });
      return new Promise<unknown>(() => {});
    };

    setTelegramFetchForTests(hangingFetch);
    setTelegramRequestTimeoutForTests(10);
    const sendPromise = (
      fetch as unknown as (url: string, init?: object) => Promise<unknown>
    )("https://api.telegram.org/bottoken/sendMessage", {});
    await expect(sendPromise).rejects.toThrow(/timed out/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it("never applies the request timeout to long-poll getUpdates", async () => {
    const options = createTelegramBotOptions(makeTelegramConfig());
    const fetch = options.client?.fetch;
    expect(fetch).toBeTypeOf("function");
    if (typeof fetch !== "function") return;

    let calls = 0;
    const instantFetch = (): Promise<unknown> => {
      calls += 1;
      return Promise.resolve({ ok: true });
    };

    setTelegramFetchForTests(instantFetch);
    await (fetch as unknown as (url: string, init?: object) => Promise<unknown>)(
      "https://api.telegram.org/bottoken/getUpdates",
      {},
    );
    expect(calls).toBe(1);
  });
});
