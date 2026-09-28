import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenCodeProvidersFromCatalog,
  parseFreeLlmCatalog,
  refreshFreeLlmCatalog,
  __resetFreeLlmCatalogForTests,
} from "../../../src/app/services/free-llm-catalog-service.js";


let tempHome = "";
let previousHome: string | undefined;
let previousGithubToken: string | undefined;

beforeEach(async () => {
  __resetFreeLlmCatalogForTests();
  previousHome = process.env.OPENCODE_TELEGRAM_HOME;
  previousGithubToken = process.env.GITHUB_TOKEN;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "free-llm-catalog-test-"));
  process.env.OPENCODE_TELEGRAM_HOME = tempHome;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (previousHome === undefined) delete process.env.OPENCODE_TELEGRAM_HOME;
  else process.env.OPENCODE_TELEGRAM_HOME = previousHome;
  if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = previousGithubToken;
  await fs.rm(tempHome, { recursive: true, force: true });
});

describe("Free LLM catalog", () => {
  it("injects only verified direct providers that need no user credential", () => {
    const catalog = parseFreeLlmCatalog({
      schemaVersion: 1,
      generatedAt: "2026-09-28T00:00:00Z",
      providers: [
        {
          id: "direct",
          runtimeId: "runtime-direct",
          name: "Direct",
          status: "verified",
          integration: "direct-openai",
          enabledByDefault: true,
          baseURL: "https://direct.example/v1",
          auth: { mode: "none", userCredentialRequired: false },
          models: [
            {
              id: "model-a",
              name: "Model A",
              toolCall: true,
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          ],
        },
        {
          id: "bridge",
          name: "Bridge",
          status: "adapter-required",
          integration: "self-hosted-bridge",
          enabledByDefault: false,
          auth: { mode: "none", userCredentialRequired: false },
          models: [{ id: "model-b", name: "Model B" }],
        },
      ],
    });

    const providers = buildOpenCodeProvidersFromCatalog(catalog);
    expect(Object.keys(providers)).toEqual(["runtime-direct"]);
    expect(providers["runtime-direct"]).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Direct",
      options: { baseURL: "https://direct.example/v1" },
      models: {
        "model-a": {
          name: "Model A",
          attachment: true,
          tool_call: true,
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      },
    });
  });

  it("uses only catalog-owned public anonymous constants, never user credentials", () => {
    const catalog = parseFreeLlmCatalog({
      schemaVersion: 1,
      generatedAt: "2026-09-28T00:00:00Z",
      providers: [
        {
          id: "horde",
          name: "Horde",
          status: "verified",
          integration: "direct-openai",
          enabledByDefault: true,
          baseURL: "https://example.test/v1",
          auth: {
            mode: "public-anonymous-token",
            userCredentialRequired: false,
            value: "0000000000",
          },
          models: [{ id: "model-a", name: "Model A" }],
        },
      ],
    });

    expect(buildOpenCodeProvidersFromCatalog(catalog).horde).toMatchObject({
      options: {
        baseURL: "https://example.test/v1",
        apiKey: "0000000000",
      },
    });
  });

  it("fails closed on providers that require a user credential", () => {
    expect(() => parseFreeLlmCatalog({
      schemaVersion: 1,
      generatedAt: "2026-09-28T00:00:00Z",
      providers: [
        {
          id: "bad",
          name: "Bad",
          status: "verified",
          integration: "direct-openai",
          enabledByDefault: true,
          baseURL: "https://bad.example/v1",
          auth: { mode: "none", userCredentialRequired: true },
          models: [{ id: "model", name: "Model" }],
        },
      ],
    })).toThrow("contains no valid providers");
  });

  it("does not inject non-HTTPS provider URLs", () => {
    const catalog = parseFreeLlmCatalog({
      schemaVersion: 1,
      generatedAt: "2026-09-28T00:00:00Z",
      providers: [
        {
          id: "unsafe",
          name: "Unsafe",
          status: "verified",
          integration: "direct-openai",
          enabledByDefault: true,
          baseURL: "http://unsafe.example/v1",
          auth: { mode: "none", userCredentialRequired: false },
          models: [{ id: "model", name: "Model" }],
        },
      ],
    });

    expect(buildOpenCodeProvidersFromCatalog(catalog)).toEqual({});
  });

  it("fetches the public raw catalog without using GitHub credentials", async () => {
    process.env.GITHUB_TOKEN = "must-not-be-used";
    const body = {
      schemaVersion: 1,
      generatedAt: "2026-09-28T01:00:00Z",
      providers: [
        {
          id: "public",
          name: "Public",
          status: "verified",
          integration: "direct-openai",
          enabledByDefault: true,
          baseURL: "https://public.example/v1",
          auth: { mode: "none", userCredentialRequired: false },
          models: [{ id: "model", name: "Model" }],
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", etag: "\"catalog-v1\"" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshFreeLlmCatalog();

    expect(result.changed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "raw.githubusercontent.com/aminsh35322088-ctrl/Free-LLM-Catalog/main/catalog.json",
    );
    const options = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> };
    expect(options.headers).not.toHaveProperty("Authorization");
  });

  it("uses ETag conditional requests and accepts 304 without rewriting the catalog", async () => {
    const body = {
      schemaVersion: 1,
      generatedAt: "2026-09-28T02:00:00Z",
      providers: [
        {
          id: "public",
          name: "Public",
          status: "verified",
          integration: "direct-openai",
          enabledByDefault: true,
          baseURL: "https://public.example/v1",
          auth: { mode: "none", userCredentialRequired: false },
          models: [{ id: "model", name: "Model" }],
        },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json", etag: "\"catalog-v2\"" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await refreshFreeLlmCatalog()).changed).toBe(true);
    expect((await refreshFreeLlmCatalog()).changed).toBe(false);

    const secondOptions = fetchMock.mock.calls[1]?.[1] as { headers?: Record<string, string> };
    expect(secondOptions.headers?.["If-None-Match"]).toBe("\"catalog-v2\"");
  });
});
