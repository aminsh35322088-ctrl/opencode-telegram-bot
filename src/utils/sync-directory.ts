import { open } from "node:fs/promises";

/**
 * Durability barrier for a file that was just renamed into place.
 *
 * Windows rejects `fsync` on a *directory* handle with `EPERM`, so on Windows
 * this is a no-op and the rename is only as durable as the OS makes it.
 * File-level `fsync` inside the same writes is unaffected. The Bot already made
 * exactly this call for app-state persistence (`src/app/stores/app-state-store.ts`),
 * which is why that store works on Windows while the write-through stores below
 * did not; this helper applies the same rule to every one of them so a Windows
 * host can persist them at all. On every other platform the barrier behaves
 * exactly as before.
 */
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
