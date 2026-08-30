import fs from "node:fs/promises";
import path from "node:path";
import { getRuntimePaths } from "../../runtime/paths.js";

const STORE_FILENAME = "custom-providers.json";
const DEFAULT_MODEL = "gemini-3.1-flash-image";
interface Provider { id: string; keyFile: string; models?: Array<{ id: string; name: string }>; }
interface Store { providers?: Provider[]; media?: { keyFile: string; model: string }; }
function storePath(): string { return path.join(getRuntimePaths().appHome, STORE_FILENAME); }
async function readStore(): Promise<Store> { try { return JSON.parse(await fs.readFile(storePath(), "utf8")) as Store; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; } }
export async function getGeminiImageConfig(): Promise<{ apiKey: string; model: string } | undefined> {
  const store = await readStore();
  const source = store.media ?? store.providers?.find((p) => p.id === "gemini-image");
  if (!source?.keyFile) return undefined;
  try { const apiKey = (await fs.readFile(path.join(getRuntimePaths().appHome, source.keyFile), "utf8")).trim(); const model = "model" in source && source.model ? source.model : DEFAULT_MODEL; return apiKey ? { apiKey, model } : undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function isGeminiImageConfigured(): Promise<boolean> { return Boolean(await getGeminiImageConfig()); }
export const DEFAULT_GEMINI_IMAGE_MODEL = DEFAULT_MODEL;
