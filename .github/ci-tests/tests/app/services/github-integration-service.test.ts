import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("GitHub integration Worker credential resolver", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "github-integration-"));
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", home);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:test-bot-token");
    vi.stubEnv("TELEGRAM_USER_ID", "1");
    vi.stubGlobal("fetch", vi.fn(async () => {
      return new Response(JSON.stringify({ login: "fixture-user" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("resolves only the selected account and immediately fences the previous one", async () => {
    const service = await import("../../../src/app/services/github-integration-service.js");
    const personal = await service.addGithubAccount("Personal", "ghp_personal-token");
    const work = await service.addGithubAccount("Work", "ghp_work-token");

    expect(await service.resolveActiveGithubCredentialForWorker(personal.id)).toBe("ghp_personal-token");
    expect(await service.resolveActiveGithubCredentialForWorker(work.id)).toBeNull();

    await service.setActiveGithubAccount(work.id);
    expect(await service.resolveActiveGithubCredentialForWorker(personal.id)).toBeNull();
    expect(await service.resolveActiveGithubCredentialForWorker(work.id)).toBe("ghp_work-token");

    await service.removeGithubAccount(work.id);
    expect(await service.resolveActiveGithubCredentialForWorker(work.id)).toBeNull();
  });
});
