import { describe, expect, it } from "vitest";
import {
  buildOpenCodeProvidersFromCatalog,
  parseFreeLlmCatalog,
} from "../../../src/app/services/free-llm-catalog-service.js";

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
});
