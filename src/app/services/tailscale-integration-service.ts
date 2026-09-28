import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { readAppState, updateAppState } from "../stores/app-state-store.js";

const execFileAsync = promisify(execFile);
const TAILSCALE_BIN = process.env.TAILSCALE_BIN?.trim() || "/usr/local/bin/tailscale";
const HOSTNAME = "opencode-bot";
const KEY_SALT = Buffer.from("opencode-telegram-bot:tailscale:v1", "utf8");
const KEY_INFO = Buffer.from("tailscale-auth-key", "utf8");

interface EncryptedSecret {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}
interface StoredTailscaleConfig {
  version: 1;
  hostname: string;
  authKey: EncryptedSecret;
  configuredAt: string;
}
interface TailscalePeer {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  Tags?: string[];
  OS?: string;
  ID?: string;
  PublicKey?: string;
  sshHostKeys?: string[];
}
interface TailscaleStatusJson {
  BackendState?: string;
  Self?: TailscalePeer;
  Peer?: Record<string, TailscalePeer>;
  CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string };
}
export interface TailscaleDevice {
  name: string;
  dnsName?: string;
  ips: string[];
  online: boolean;
  tags: string[];
  os?: string;
  identity: string;
  sshHostKeys: string[];
  nativeTailscaleSsh: boolean;
  sshEligible: boolean;
  sshReason: "eligible" | "missing-tag:ssh" | "offline";
}
export type TailscaleSshDevice = TailscaleDevice;
export interface TailscaleRuntimeStatus {
  configured: boolean;
  connected: boolean;
  daemonRunning: boolean;
  backendState?: string;
  hostname: string;
  tailnet?: string;
  ips: string[];
  selfTags: string[];
  visiblePeers: number;
  sshDevices: number;
}

const TAILSCALE_SOCKET = process.env.TAILSCALE_SOCKET?.trim() || "/data/run/tailscale/tailscaled.sock";

function paths() {
  return { socket: TAILSCALE_SOCKET };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integrationState(state: Awaited<ReturnType<typeof readAppState>>): Record<string, unknown> {
  return isRecord(state.integrations) ? state.integrations : {};
}
function normalizeStored(value: unknown): StoredTailscaleConfig | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.hostname !== "string" || typeof value.configuredAt !== "string" || !isRecord(value.authKey)) return null;
  const auth = value.authKey;
  if (auth.version !== 1 || typeof auth.iv !== "string" || typeof auth.tag !== "string" || typeof auth.ciphertext !== "string") return null;
  return {
    version: 1,
    hostname: value.hostname,
    configuredAt: value.configuredAt,
    authKey: { version: 1, iv: auth.iv, tag: auth.tag, ciphertext: auth.ciphertext },
  };
}
async function readStored(): Promise<StoredTailscaleConfig | null> {
  const state = await readAppState();
  return normalizeStored(integrationState(state).tailscale);
}
async function writeStored(value: StoredTailscaleConfig | null): Promise<void> {
  const state = await readAppState();
  const integrations = { ...integrationState(state) };
  if (value) integrations.tailscale = value;
  else delete integrations.tailscale;
  await updateAppState({ integrations });
}

function key(): Buffer {
  const token = config.telegram.token;
  if (!token) throw new Error("Cannot protect Tailscale credentials without the Telegram bot token.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(token, "utf8"), KEY_SALT, KEY_INFO, 32));
}
function encryptAuthKey(secret: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from("tailscale", "utf8"));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
function decryptAuthKey(secret: EncryptedSecret): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(secret.iv, "base64"));
    decipher.setAAD(Buffer.from("tailscale", "utf8"));
    decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new Error("Unable to decrypt the stored Tailscale auth key.", { cause: error });
  }
}
function normalizeAuthKey(value: string): string {
  const authKey = value.trim();
  if (!authKey) throw new Error("Tailscale auth key is empty.");
  if (authKey.length > 4096 || /[\r\n\0]/u.test(authKey)) throw new Error("Tailscale auth key is invalid.");
  return authKey;
}

async function cli(args: string[], timeout = 12_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const { socket } = paths();
  try {
    const { stdout, stderr } = await execFileAsync(TAILSCALE_BIN, [`--socket=${socket}`, ...args], {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? String(error) };
  }
}

async function socketReady(): Promise<boolean> {
  return fs.stat(paths().socket).then((stat) => stat.isSocket()).catch(() => false);
}

async function waitForSocket(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export async function ensureTailscaleDaemon(): Promise<void> {
  if (await socketReady()) return;
  if (!await waitForSocket()) {
    throw new Error("The shared tailscaled socket is unavailable. Railway entrypoint must own the single daemon.");
  }
}

async function statusJson(): Promise<TailscaleStatusJson | null> {
  const result = await cli(["status", "--json"], 5_000);
  if (!result.ok) return null;
  try { return JSON.parse(result.stdout) as TailscaleStatusJson; }
  catch { return null; }
}

async function up(authKey?: string): Promise<void> {
  await ensureTailscaleDaemon();
  const args = ["up", `--hostname=${HOSTNAME}`, "--accept-dns=false"];
  if (authKey) args.push(`--auth-key=${authKey}`);
  const result = await cli(args, 20_000);
  if (!result.ok) throw new Error(result.stderr.trim() || "tailscale up failed.");
}

export async function configureTailscale(authKeyValue: string): Promise<void> {
  const authKey = normalizeAuthKey(authKeyValue);
  await up(authKey);
  await enforceStableHostname();
  await writeStored({ version: 1, hostname: HOSTNAME, authKey: encryptAuthKey(authKey), configuredAt: new Date().toISOString() });
}

async function enforceStableHostname(): Promise<void> {
  const result = await cli(["set", `--hostname=${HOSTNAME}`], 8_000);
  if (!result.ok) throw new Error(result.stderr.trim() || "tailscale set --hostname failed.");
}

export async function initializeTailscaleIntegration(): Promise<boolean> {
  const stored = await readStored();
  if (!stored) return false;
  try {
    await ensureTailscaleDaemon();
    const status = await statusJson();
    if (status?.BackendState !== "Running") {
      await up(decryptAuthKey(stored.authKey));
    }
    await enforceStableHostname();
    return true;
  } catch (error) {
    logger.warn("[Tailscale] Stored integration could not connect; bot will continue without Tailnet access.", error);
    return false;
  }
}

export async function reconnectTailscale(): Promise<void> {
  const stored = await readStored();
  if (!stored) throw new Error("Tailscale is not configured.");
  await ensureTailscaleDaemon();
  await up(decryptAuthKey(stored.authKey));
  await enforceStableHostname();
}

export async function disconnectTailscale(): Promise<void> {
  await ensureTailscaleDaemon();
  await cli(["down"], 8_000);
}

export async function removeTailscaleIntegration(): Promise<void> {
  if (await socketReady()) await cli(["logout"], 10_000).catch(() => ({ ok: false, stdout: "", stderr: "" }));
  await writeStored(null);
}

export async function stopTailscaleIntegration(): Promise<void> {
  // The daemon is owned by railway-entrypoint.sh and intentionally outlives the bot process.
}

function normalizeTarget(value: string): string {
  return value.trim().replace(/\.$/u, "").toLowerCase();
}
function allPeers(status: TailscaleStatusJson | null): TailscalePeer[] {
  return status ? Object.values(status.Peer ?? {}) : [];
}
function isSshPeer(peer: TailscalePeer): boolean {
  return (peer.Tags ?? []).includes("tag:ssh");
}
function toDevice(peer: TailscalePeer): TailscaleDevice {
  const tags = peer.Tags ?? [];
  const online = peer.Online === true;
  const taggedForSsh = tags.includes("tag:ssh");
  const sshHostKeys = peer.sshHostKeys ?? [];
  const identitySource =
    peer.ID?.trim() ||
    peer.PublicKey?.trim() ||
    (sshHostKeys.length > 0 ? sshHostKeys.slice().sort().join("\n") : "") ||
    [
      peer.HostName?.trim() ?? "",
      peer.DNSName?.trim() ?? "",
      ...(peer.TailscaleIPs ?? []),
    ].join("|");
  const identity = createHash("sha256").update(identitySource, "utf8").digest("hex").slice(0, 32);
  return {
    name: peer.HostName?.trim() || peer.DNSName?.split(".")[0] || peer.TailscaleIPs?.[0] || "unknown",
    ...(peer.DNSName ? { dnsName: peer.DNSName.replace(/\.$/u, "") } : {}),
    ips: peer.TailscaleIPs ?? [],
    online,
    tags,
    ...(peer.OS ? { os: peer.OS } : {}),
    identity,
    sshHostKeys,
    nativeTailscaleSsh: sshHostKeys.length > 0,
    sshEligible: taggedForSsh && online,
    sshReason: !taggedForSsh ? "missing-tag:ssh" : online ? "eligible" : "offline",
  };
}

export async function listTailscaleDevices(): Promise<TailscaleDevice[]> {
  if (!await readStored()) return [];
  await ensureTailscaleDaemon();
  const status = await statusJson();
  return allPeers(status).map(toDevice).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listTailscaleSshDevices(): Promise<TailscaleSshDevice[]> {
  return (await listTailscaleDevices()).filter((device) => device.tags.includes("tag:ssh"));
}

export async function resolveTailscaleSshDevice(targetValue: string): Promise<TailscaleSshDevice> {
  const target = normalizeTarget(targetValue);
  if (!target) throw new Error("SSH target is required.");
  const devices = await listTailscaleDevices();
  const device = devices.find((candidate) => {
    const names = [candidate.name, candidate.dnsName, ...candidate.ips].filter((value): value is string => Boolean(value)).map(normalizeTarget);
    return names.includes(target) || names.some((name) => name.split(".")[0] === target);
  });
  if (!device) throw new Error("Target is not visible in the bot's Tailnet netmap.");
  if (!device.tags.includes("tag:ssh")) throw new Error(`Tailnet device "${device.name}" is visible but missing tag:ssh.`);
  if (!device.online) throw new Error(`Tailnet SSH device "${device.name}" is offline.`);
  return device;
}

export async function pingTailscaleSshDevice(target: string): Promise<{ ok: boolean; device: TailscaleSshDevice; output: string }> {
  const device = await resolveTailscaleSshDevice(target);
  const result = await cli(["ping", "--timeout=8s", device.name], 10_000);
  return { ok: result.ok, device, output: (result.stdout || result.stderr).trim().slice(0, 8000) };
}

export async function getTailscaleRuntimeStatus(): Promise<TailscaleRuntimeStatus> {
  const stored = await readStored();
  if (!stored) return { configured: false, connected: false, daemonRunning: false, hostname: HOSTNAME, ips: [], selfTags: [], visiblePeers: 0, sshDevices: 0 };
  try {
    await ensureTailscaleDaemon();
    const status = await statusJson();
    const peers = allPeers(status);
    const sshDevices = peers.filter(isSshPeer);
    return {
      configured: true,
      connected: status?.BackendState === "Running",
      daemonRunning: await socketReady(),
      backendState: status?.BackendState,
      hostname: status?.Self?.HostName || HOSTNAME,
      tailnet: status?.CurrentTailnet?.Name,
      ips: status?.Self?.TailscaleIPs ?? [],
      selfTags: status?.Self?.Tags ?? [],
      visiblePeers: peers.length,
      sshDevices: sshDevices.length,
    };
  } catch {
    return { configured: true, connected: false, daemonRunning: false, hostname: HOSTNAME, ips: [], selfTags: [], visiblePeers: 0, sshDevices: 0 };
  }
}

export function getTailscaleSocketPath(): string {
  return paths().socket;
}
