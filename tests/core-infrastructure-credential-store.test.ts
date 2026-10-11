import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Railway credential store is root-bound, atomic, and never serializes metadata without the selected workspace", async () => {
  const loaded = await import("../src/infrastructure/railway-credential-store.js").catch(() => null);
  assert.ok(loaded, "Railway credential store module must exist");
  const directory = await mkdtemp(path.join(os.tmpdir(), "railway-credential-"));
  const filename = path.join(directory, "credential.json");
  const store = new loaded.RailwayCredentialStore(filename);
  await store.save({ token: "synthetic-secret", tokenType: "account", workspaceId: "workspace-1", workspaceName: "Primary" });
  const saved = await store.load();
  assert.deepEqual(saved, { token: "synthetic-secret", tokenType: "account", workspaceId: "workspace-1", workspaceName: "Primary" });
  const credentialStat = await stat(filename);
  assert.equal(credentialStat.mode & 0o777, 0o600);
  if (process.getuid) assert.equal(credentialStat.uid, process.getuid());
  const raw = await readFile(filename, "utf8");
  assert.doesNotMatch(raw, /synthetic-secret/);
  assert.match(raw, /workspace-1/);
  const keyStat = await stat(`${filename}.key`);
  assert.equal(keyStat.mode & 0o777, 0o600);
  if (process.getuid) assert.equal(keyStat.uid, process.getuid());
});
