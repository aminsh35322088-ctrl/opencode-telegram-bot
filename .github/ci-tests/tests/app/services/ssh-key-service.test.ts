import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("managed SSH key service", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-key-service-"));
    const fakeKeygen = path.join(dir, "fake-ssh-keygen.sh");
    await fs.writeFile(fakeKeygen, `#!/bin/sh
set -eu
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-f" ]; then out="$2"; shift 2; continue; fi
  shift
done
printf '%s\\n' 'PRIVATE-TEST-KEY' > "$out"
printf '%s\\n' 'ssh-ed25519 AAAATEST opencode-bot@tailscale' > "$out.pub"
`, { mode: 0o755 });
    vi.stubEnv("SSH_KEY_DIR", path.join(dir, "keys"));
    vi.stubEnv("SSH_KEYGEN_BIN", fakeKeygen);
    vi.resetModules();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("generates a stable keypair with restrictive private permissions", async () => {
    const service = await import("../../../src/app/services/ssh-key-service.js");
    const first = await service.getManagedSshPublicKey();
    const second = await service.getManagedSshPublicKey();
    expect(first).toBe("ssh-ed25519 AAAATEST opencode-bot@tailscale");
    expect(second).toBe(first);
    const privatePath = await service.getManagedSshPrivateKeyPath();
    expect((await fs.stat(privatePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(privatePath))).mode & 0o777).toBe(0o700);
  });

  it("creates a private known_hosts file", async () => {
    const service = await import("../../../src/app/services/ssh-key-service.js");
    const knownHosts = await service.getManagedSshKnownHostsPath();
    expect((await fs.stat(knownHosts)).mode & 0o777).toBe(0o600);
  });
});
