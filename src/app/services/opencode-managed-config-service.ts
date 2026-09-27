import { opencodeClient } from "../../opencode/client.js";
import { waitForOpencodeReadyAndRefresh } from "../../opencode/ready-refresh.js";
import { syncOpenCodeCustomConfig } from "./custom-provider-service.js";

export async function syncManagedOpenCodeConfig(): Promise<string> {
  const configPath = await syncOpenCodeCustomConfig();
  process.env.OPENCODE_CONFIG = configPath;
  return configPath;
}

export async function reloadManagedOpenCodeConfig(
  reason: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  await syncManagedOpenCodeConfig();

  const { error } = await opencodeClient.global.dispose();
  if (error) {
    throw new Error("OpenCode rejected the managed Extension config reload.");
  }

  const refreshed = await waitForOpencodeReadyAndRefresh(reason, {
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  if (!refreshed) {
    throw new Error("OpenCode did not become ready after managed Extension reload.");
  }
}
