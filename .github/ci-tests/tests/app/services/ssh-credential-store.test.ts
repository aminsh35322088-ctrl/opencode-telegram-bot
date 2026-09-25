import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedConfig = vi.hoisted(() => ({ token: "telegram-token-a" }));
vi.mock("../../../src/config.js", () => ({
  config: {
    get telegram() {
      return { token: mockedConfig.token, allowedUserId: 1, proxyUrl: "", apiRoot: "", proxySecret: "", forceIpv4: false };
    },
    opencode: {
      apiUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "",
      autoRestartEnabled: true,
      monitorIntervalSec: 20,
      model: { provider: "opencode", modelId: "big-pickle" },
    },
  },
}));

import {
  listSshCredentialSummaries,
  loadSshCredential,
  removeSshCredential,
  saveSshPasswordCredential,
  saveSshPrivateKeyCredential,
} from "../../../src/app/services/ssh-credential-store.js";

describe("ssh credential store", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-credential-store-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
    mockedConfig.token = "telegram-token-a";
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("encrypts password/private-key credentials at rest and lists metadata only", async () => {
    await saveSshPasswordCredential("vps-password", "VPS password", "super-secret-password");
    await saveSshPrivateKeyCredential(
      "vps-key",
      "VPS key",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----\n",
    );

    const raw = await fs.readFile(path.join(home, "app-state.json"), "utf8");
    expect(raw).not.toContain("super-secret-password");
    expect(raw).not.toContain("OPENSSH PRIVATE KEY");
    expect(raw).not.toContain("abc123");

    const summaries = await listSshCredentialSummaries();
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "vps-password", mode: "password" }),
      expect.objectContaining({ id: "vps-key", mode: "private-key" }),
    ]));
    expect(JSON.stringify(summaries)).not.toContain("super-secret-password");

    await expect(loadSshCredential("vps-password")).resolves.toEqual(expect.objectContaining({ password: "super-secret-password" }));
    await expect(removeSshCredential("vps-password")).resolves.toBe(true);
    await expect(loadSshCredential("vps-password")).resolves.toBeNull();
  });

  it("fails closed if the encryption key changes", async () => {
    await saveSshPasswordCredential("secure", "Secure", "bound-secret");
    mockedConfig.token = "telegram-token-b";
    await expect(loadSshCredential("secure")).rejects.toThrow(/decrypt/i);
  });
});
