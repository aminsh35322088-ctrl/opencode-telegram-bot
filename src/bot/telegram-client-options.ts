import nodeFetch, {
  type RequestInfo as NodeFetchRequestInfo,
  type RequestInit as NodeFetchRequestInit,
} from "node-fetch";
import { Agent as HttpsAgent } from "https";
import type { Bot, Context } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { logger } from "../utils/logger.js";

export interface TelegramClientConfig {
  apiRoot: string;
  proxySecret: string;
  proxyUrl: string;
  forceIpv4: boolean;
}

export type TelegramBotOptions = NonNullable<ConstructorParameters<typeof Bot<Context>>[1]>;

export const TELEGRAM_API_REQUEST_TIMEOUT_MS = 30_000;

type TelegramFetch = (
  url: NodeFetchRequestInfo,
  init: NodeFetchRequestInit | undefined,
) => Promise<unknown>;

let fetchOverrideForTests: TelegramFetch | null = null;
let requestTimeoutForTests: number | null = null;

export function setTelegramFetchForTests(fetch: TelegramFetch): void {
  fetchOverrideForTests = fetch;
}

export function setTelegramRequestTimeoutForTests(timeoutMs: number): void {
  requestTimeoutForTests = timeoutMs;
}

export function resetTelegramFetchForTests(): void {
  fetchOverrideForTests = null;
  requestTimeoutForTests = null;
}

function requestUrlText(url: NodeFetchRequestInfo): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.toString();
  const candidate = (url as { url?: unknown }).url;
  return typeof candidate === "string" ? candidate : String(url);
}

function isLongPollRequest(url: NodeFetchRequestInfo): boolean {
  return requestUrlText(url).includes("/getUpdates");
}

// Long-poll getUpdates legitimately waits server-side for new updates, so it
// is the one Bot API call that must never be force-timed-out. Everything else
// gets a bounded budget: a stalled socket must surface as an error (which the
// retry transformer and streamers already handle) instead of hanging forever.
async function fetchWithRequestTimeout(
  url: NodeFetchRequestInfo,
  init: NodeFetchRequestInit | undefined,
  proxySecret: string,
): Promise<unknown> {
  const transport = (fetchOverrideForTests ?? nodeFetch) as unknown as TelegramFetch;
  if (isLongPollRequest(url)) {
    return transport(url, init);
  }

  const timeoutMs = requestTimeoutForTests ?? TELEGRAM_API_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const onParentAbort = () => {
    try {
      controller.abort((init?.signal as AbortSignal | undefined)?.reason);
    } catch {
      controller.abort();
    }
  };
  const parentSignal = init?.signal as AbortSignal | undefined;
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`Telegram API request timed out after ${timeoutMs}ms`));
      reject(new Error(`Telegram API request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    const existing = (init?.headers as Record<string, string> | undefined) ?? {};
    const headers = proxySecret ? { ...existing, "X-Proxy-Secret": proxySecret } : existing;
    return await Promise.race([transport(url, { ...(init ?? {}), headers, signal: controller.signal }), timeoutError]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export function createTelegramIpv4Agent(): HttpsAgent {
  return new HttpsAgent({ family: 4, keepAlive: true });
}

export function createTelegramBotOptions(telegram: TelegramClientConfig): TelegramBotOptions {
  const botOptions: TelegramBotOptions = {};

  if (telegram.apiRoot || telegram.proxySecret) {
    botOptions.client = botOptions.client ?? {};
    if (telegram.apiRoot) {
      botOptions.client.apiRoot = telegram.apiRoot;
      logger.info(`[Bot] Using custom Telegram API root: ${telegram.apiRoot}`);
    }
    if (telegram.proxySecret) {
      // Inject the shared-secret header via a custom fetch wrapper instead of
      // baseFetchConfig.headers, because grammY's client spreads
      // `{...baseFetchConfig, ...config}` and the per-request config.headers
      // (Content-Type/Length) wipes out anything we put on baseFetchConfig.
      // Plain-object headers merge (not the Headers class) keeps this compatible
      // with node-fetch v2's init shape and avoids the DOM lib HeadersInit type.
      logger.info(`[Bot] Sending X-Proxy-Secret header to Telegram API root`);
    }
  }

  // Every Bot API call goes through this wrapper so a stalled socket can never
  // hang a stream, a completion queue, or a finalize path forever. Retry and
  // flood-wait delays live above this layer and are unaffected.
  const proxySecret = telegram.proxySecret;
  botOptions.client = botOptions.client ?? {};
  botOptions.client.fetch = ((
    url: NodeFetchRequestInfo,
    init: NodeFetchRequestInit | undefined,
  ) => fetchWithRequestTimeout(url, init, proxySecret)) as unknown as typeof nodeFetch;

  if (telegram.proxyUrl) {
    const proxyUrl = telegram.proxyUrl;
    let agent;

    if (proxyUrl.startsWith("socks")) {
      agent = new SocksProxyAgent(proxyUrl);
      logger.info(`[Bot] Using SOCKS proxy: ${proxyUrl.replace(/\/\/.*@/, "//***@")}`);
    } else {
      agent = new HttpsProxyAgent(proxyUrl);
      logger.info(`[Bot] Using HTTP/HTTPS proxy: ${proxyUrl.replace(/\/\/.*@/, "//***@")}`);
    }

    botOptions.client = botOptions.client ?? {};
    botOptions.client.baseFetchConfig = {
      agent,
      compress: true,
    };
  } else if (telegram.forceIpv4) {
    botOptions.client = botOptions.client ?? {};
    botOptions.client.baseFetchConfig = {
      ...(botOptions.client.baseFetchConfig ?? {}),
      agent: createTelegramIpv4Agent(),
      compress: true,
    };
    logger.info(`[Bot] Forcing IPv4 for Telegram API requests`);
  }

  return botOptions;
}
