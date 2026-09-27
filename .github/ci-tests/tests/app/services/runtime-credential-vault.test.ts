import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    telegram: {
      token: "123456:credential-vault-test-token",
      allowedUserId: 1,
      proxyUrl: "",
      apiRoot: "",
      proxySecret: "",
      forceIpv4: false,
    },
    opencode: {
      apiUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "",
      autoRestartEnabled: false,
      monitorIntervalSec: 20,
      model: { provider: "opencode", modelId: "test-model" },
    },
  },
}));

import { readAppState, updateAppState } from "../../../src/app/stores/app-state-store.js";
import {
  addGithubAccount,
  initializeGithubIntegration,
} from "../../../src/app/services/github-integration-service.js";
import {
  clearFreeModelSourceCredential,
  listFreeModelSourceConnections,
  migrateLegacyFreeModelSourceCredentials,
  setFreeModelSourceCredential,
} from "../../../src/app/services/free-model-source-service.js";
import {
  configureGroqStt,
  getGroqSttConfig,
  migrateLegacyCustomProviderCredentials,
  removeGroqStt,
} from "../../../src/app/services/custom-provider-service.js";
import {
  configureImageAiProvider,
  getActiveImageAiProviders,
  migrateLegacyImageAiCredentials,
  removeImageAiProvider,
} from "../../../src/app/services/image-ai-provider-service.js";

async function stateText(home: string): Promise<string> {
  return await fs.readFile(path.join(home, "app-state.json"), "utf8");
}

describe("runtime credentials use Credential Vault", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-credential-vault-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    vi.unstubAllGlobals();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("stores GitHub tokens only in the encrypted vault", async () => {
    const secret = "github-secret-value";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ login: "vault-user" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await addGithubAccount("Primary", secret);
    const raw = await stateText(home);

    expect(raw).not.toContain(secret);
    expect(raw).toContain('"credentialVault"');
    expect(raw).toContain('"credentialId": "token"');
    await expect(initializeGithubIntegration()).resolves.toBe(true);
    expect(process.env.GITHUB_TOKEN).toBe(secret);
  });
  it("stores free-source credentials only in the encrypted vault", async () => {
    const secret = "deepseek-secret-value";
    await setFreeModelSourceCredential("ds", secret);

    const raw = await stateText(home);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('"deepseekToken"');

    const connection = (await listFreeModelSourceConnections())
      .find((item) => item.id === "ds");
    expect(connection?.configured).toBe(true);

    await expect(clearFreeModelSourceCredential("ds")).resolves.toBe(true);
    expect((await listFreeModelSourceConnections()).find((item) => item.id === "ds")?.configured)
      .toBe(false);
  });

  it("migrates legacy free-source plaintext and scrubs app-state", async () => {
    const secret = "legacy-free-source-secret";
    await updateAppState({
      freeModelSources: { deepseekToken: secret },
    });

    await expect(migrateLegacyFreeModelSourceCredentials()).resolves.toBe(1);
    const raw = await stateText(home);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('"deepseekToken"');
    expect((await listFreeModelSourceConnections()).find((item) => item.id === "ds")?.configured)
      .toBe(true);
  });
  it("stores Groq STT keys only in the encrypted vault", async () => {
    const secret = "groq-secret-value";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "whisper-large-v3" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await configureGroqStt(secret);
    const raw = await stateText(home);
    expect(raw).not.toContain(secret);
    expect(raw).toContain('"credentialId": "api-key"');

    await expect(getGroqSttConfig()).resolves.toMatchObject({
      apiKey: secret,
      model: "whisper-large-v3",
    });
    await expect(removeGroqStt()).resolves.toBe(true);
    await expect(getGroqSttConfig()).resolves.toBeUndefined();
  });

  it("migrates legacy Groq STT plaintext and scrubs app-state", async () => {
    const secret = "legacy-groq-secret";
    await updateAppState({
      customProviders: {
        providers: [],
        stt: {
          provider: "groq",
          apiKey: secret,
          model: "whisper-large-v3",
          updatedAt: "2026-09-27T00:00:00.000Z",
        },
      },
    });

    await expect(migrateLegacyCustomProviderCredentials()).resolves.toBe(1);
    const raw = await stateText(home);
    expect(raw).not.toContain(secret);
    await expect(getGroqSttConfig()).resolves.toMatchObject({ apiKey: secret });
  });
  it("stores custom Image AI keys only in the encrypted vault", async () => {
    const secret = "image-secret-value";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "image-model" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    await configureImageAiProvider("custom-image-ai", secret, {
      baseURL: "https://images.example/v1",
      model: "image-model",
      name: "Image Test",
    });

    const raw = await stateText(home);
    expect(raw).not.toContain(secret);
    expect(raw).toContain('"credentialId": "api-key"');

    const active = await getActiveImageAiProviders();
    expect(active[0]?.apiKey).toBe(secret);

    await expect(removeImageAiProvider("custom-image-ai")).resolves.toBe(true);
    expect(await getActiveImageAiProviders()).toEqual([]);
  });

  it("migrates legacy Image AI plaintext and scrubs app-state", async () => {
    const secret = "legacy-image-secret";
    await updateAppState({
      imageAi: {
        providers: [{
          id: "custom-image-ai",
          name: "Legacy Image",
          baseURL: "https://images.example/v1",
          model: "image-model",
          capabilities: ["generate"],
          active: true,
          default: false,
          apiKey: secret,
          updatedAt: "2026-09-27T00:00:00.000Z",
        }],
      },
    });

    await expect(migrateLegacyImageAiCredentials()).resolves.toBe(1);
    const raw = await stateText(home);
    expect(raw).not.toContain(secret);
    expect((await getActiveImageAiProviders())[0]?.apiKey).toBe(secret);
  });
});
