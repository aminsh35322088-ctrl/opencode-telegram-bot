import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addCloudflareAccessAccount,
  getActiveCloudflareAccessAccount,
  getActiveCloudflareAccessCredentials,
  listCloudflareAccessAccounts,
  removeCloudflareAccessAccount,
  setActiveCloudflareAccessAccount,
} from "../../../src/app/services/cloudflare-integration-service.js";

describe("cloudflare integration service", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudflare-access-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.OPENCODE_TELEGRAM_HOME;
  });

  it("keeps service-token secrets out of public account metadata", async () => {
    const account = await addCloudflareAccessAccount("Runner Access", "client-id-1234567890", "super-secret-token");

    expect(account.name).toBe("Runner Access");
    expect(account.clientIdHint).toContain("…");
    expect(JSON.stringify(account)).not.toContain("super-secret-token");

    const listed = await listCloudflareAccessAccounts();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("super-secret-token");

    await expect(getActiveCloudflareAccessCredentials()).resolves.toEqual({
      clientId: "client-id-1234567890",
      clientSecret: "super-secret-token",
    });
  });

  it("switches and removes active accounts deterministically", async () => {
    const first = await addCloudflareAccessAccount("Primary", "client-primary", "secret-primary");
    const second = await addCloudflareAccessAccount("Runner", "client-runner", "secret-runner");

    expect((await getActiveCloudflareAccessAccount())?.id).toBe(first.id);

    await setActiveCloudflareAccessAccount(second.id);
    expect((await getActiveCloudflareAccessAccount())?.id).toBe(second.id);
    await expect(getActiveCloudflareAccessCredentials()).resolves.toEqual({
      clientId: "client-runner",
      clientSecret: "secret-runner",
    });

    expect(await removeCloudflareAccessAccount(second.id)).toBe(true);
    expect((await getActiveCloudflareAccessAccount())?.id).toBe(first.id);
  });
});
