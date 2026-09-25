import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/config.js", () => ({
  config: {
    get telegram() {
      return { token: "ssh-auth-runner-test-token", allowedUserId: 1, proxyUrl: "", apiRoot: "", proxySecret: "", forceIpv4: false };
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

import { sshCredentialRunner } from "../../../src/app/services/ssh-auth-runner.js";
import { saveSshPasswordCredential, saveSshPrivateKeyCredential } from "../../../src/app/services/ssh-credential-store.js";
import type { CommandRequest, CommandResult, CommandRunner } from "../../../src/app/services/ssh-service.js";

function result(): CommandResult {
  return { ok: true, stdout: "", stderr: "", timedOut: false, exitCode: 0, signal: null };
}

describe("ssh auth runner", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-auth-runner-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("injects a private key through a temporary 0600 file without changing the remote command", async () => {
    await saveSshPrivateKeyCredential(
      "key",
      "Key",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
    );
    let observed: CommandRequest | null = null;
    const base: CommandRunner = async (request) => {
      observed = request;
      const keyIndex = request.args.indexOf("-i");
      expect(keyIndex).toBeGreaterThanOrEqual(0);
      const keyPath = request.args[keyIndex + 1]!;
      expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(keyPath, "utf8")).toContain("OPENSSH PRIVATE KEY");
      expect(request.args.at(-1)).toBe("true");
      return result();
    };
    const runner = sshCredentialRunner("key", base);
    await runner({ bin: "/usr/bin/ssh", args: ["user@host", "true"], timeoutMs: 3000 });
    expect(observed).not.toBeNull();
  });

  it("uses SSH_ASKPASS for passwords and never places the password in argv", async () => {
    await saveSshPasswordCredential("password", "Password", "very-secret-password");
    const base: CommandRunner = async (request) => {
      expect(request.args.join(" ")).not.toContain("very-secret-password");
      expect(request.env?.OPENCODE_SSH_PASSWORD).toBe("very-secret-password");
      expect(request.env?.SSH_ASKPASS_REQUIRE).toBe("force");
      expect(request.args.join(" ")).toContain("BatchMode=no");
      return result();
    };
    const runner = sshCredentialRunner("password", base);
    await runner({ bin: "/usr/bin/ssh", args: ["user@host", "true"], timeoutMs: 3000 });
  });
});
