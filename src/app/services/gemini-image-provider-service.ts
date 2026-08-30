import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

const STORE_FILENAME = "custom-providers.json";
const DEFAULT_MODEL = "gemini-3.1-flash-image";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface Store { media?: { provider: "gemini-image"; keyFile: string; model: string; updatedAt: string }; }

function storePath(): string { return path.join(getRuntimePaths().appHome, STORE_FILENAME); }
async function readStore(): Promise<Store> { try { return JSON.parse(await fs.readFile(storePath(), "utf8")) as Store; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; } }
async function writeStore(store: Store): Promise<void> { await fs.mkdir(getRuntimePaths().appHome, { recursive: true }); const temp = `${storePath()}.tmp`; await fs.writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 }); await fs.rename(temp, storePath()); }

export async function getGeminiImageConfig(): Promise<{ apiKey: string; model: string } | undefined> {
  const store = await readStore();
  if (!store.media?.keyFile) return undefined;
  try {
    const apiKey = (await fs.readFile(path.join(getRuntimePaths().appHome, store.media.keyFile), "utf8")).trim();
    return apiKey ? { apiKey, model: store.media.model || DEFAULT_MODEL } : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function configureGeminiImage(apiKey: string, model = DEFAULT_MODEL): Promise<void> {
  const key = apiKey.trim();
  if (!key) throw new Error("API key is empty");
  const response = await fetch(`${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Gemini API key verification failed: HTTP ${response.status}`);
  const store = await readStore();
  const keyFile = "providers/gemini-image.key";
  const absoluteKeyFile = path.join(getRuntimePaths().appHome, keyFile);
  await fs.mkdir(path.dirname(absoluteKeyFile), { recursive: true });
  await fs.writeFile(absoluteKeyFile, `${key}\n`, { mode: 0o600 });
  await writeStore({ ...store, media: { provider: "gemini-image", keyFile, model, updatedAt: new Date().toISOString() } });
}

export async function removeGeminiImage(): Promise<boolean> {
  const store = await readStore();
  if (!store.media) return false;
  await fs.rm(path.join(getRuntimePaths().appHome, store.media.keyFile), { force: true });
  const { media: _media, ...next } = store;
  await writeStore(next);
  return true;
}

export async function isGeminiImageConfigured(): Promise<boolean> { return Boolean(await getGeminiImageConfig()); }
export const GEMINI_IMAGE_BASE_URL = GEMINI_BASE_URL;
