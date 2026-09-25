import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSshProfile,
  listSshProfiles,
  removeSshProfile,
  saveSshProfile,
  updateSshProfile,
} from "../../../src/app/services/ssh-profile-store.js";

describe("ssh profile store", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-profile-store-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("persists normalized non-secret profiles", async () => {
    const saved = await saveSshProfile({
      name: " GitHub Exit ",
      host: "github-exit",
      user: "runner",
      transport: "tailscale",
      compatibility: "auto",
      credentialId: "github-exit-key",
    });
    expect(saved.id).toBe("github-exit");
    expect(saved.port).toBe(22);
    await expect(getSshProfile("github-exit")).resolves.toEqual(expect.objectContaining({
      host: "github-exit",
      user: "runner",
      transport: "tailscale",
      credentialId: "github-exit-key",
    }));

    const raw = await fs.readFile(path.join(home, "app-state.json"), "utf8");
    expect(raw).toContain("github-exit");
    expect(raw).not.toContain("PRIVATE KEY");
    expect(raw).not.toContain("password");
  });

  it("updates and removes profiles without changing createdAt", async () => {
    const created = await saveSshProfile({ name: "VPS", host: "vps.example.com", user: "ubuntu", transport: "direct" });
    const updated = await updateSshProfile(created.id, { port: 2222, compatibility: "default" });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.port).toBe(2222);
    expect(updated.compatibility).toBe("default");
    await expect(listSshProfiles()).resolves.toHaveLength(1);
    await expect(removeSshProfile(created.id)).resolves.toBe(true);
    await expect(listSshProfiles()).resolves.toEqual([]);
  });

  it("rejects unsafe host and credential identifiers", async () => {
    await expect(saveSshProfile({ name: "bad", host: "host;rm -rf /", user: "root" })).rejects.toThrow(/host/i);
    await expect(saveSshProfile({ name: "bad", host: "host", user: "root", credentialId: "../secret" })).rejects.toThrow(/credential id/i);
  });
});
