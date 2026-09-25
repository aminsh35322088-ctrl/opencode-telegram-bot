import { createHash } from "node:crypto";
import { readAppState, updateAppState } from "../stores/app-state-store.js";
import { isRecord } from "../../utils/type-guards.js";

export type SshProfileTransport = "auto" | "tailscale" | "direct";
export type SshProfileCompatibility = "auto" | "default" | "ecdh-nistp256";

export interface SshServerProfile {
  id: string;
  name: string;
  host: string;
  user: string;
  port: number;
  transport: SshProfileTransport;
  compatibility: SshProfileCompatibility;
  credentialId?: string;
  createdAt: string;
  updatedAt: string;
}

interface SshProfileState {
  version: 1;
  records: Record<string, SshServerProfile>;
}

const STORE_KEY = "sshProfiles";
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function normalizeHost(value: string): string {
  const host = value.trim();
  if (!host || host.startsWith("-") || /[\s\0\r\n]/u.test(host) || !/^[A-Za-z0-9._:[\]-]+$/u.test(host)) {
    throw new Error("SSH profile host must be a hostname or IP address without whitespace or shell syntax.");
  }
  return host;
}

function normalizeUser(value: string): string {
  const user = value.trim();
  if (!user || !/^[A-Za-z0-9._-]+$/u.test(user)) throw new Error("SSH profile user is invalid.");
  return user;
}

function normalizePort(value: number): number {
  const port = Math.trunc(value);
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error("SSH profile port must be between 1 and 65535.");
  return port;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "ssh-server";
}

function parseState(value: unknown): SshProfileState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records)) return { version: 1, records: {} };
  const records: Record<string, SshServerProfile> = {};
  for (const [id, item] of Object.entries(value.records)) {
    if (
      !ID_PATTERN.test(id) ||
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.host !== "string" ||
      typeof item.user !== "string" ||
      typeof item.port !== "number" ||
      typeof item.transport !== "string" ||
      typeof item.compatibility !== "string" ||
      typeof item.createdAt !== "string" ||
      typeof item.updatedAt !== "string"
    ) continue;
    if (!["auto", "tailscale", "direct"].includes(item.transport)) continue;
    if (!["auto", "default", "ecdh-nistp256"].includes(item.compatibility)) continue;
    try {
      records[id] = {
        id,
        name: item.name.trim() || id,
        host: normalizeHost(item.host),
        user: normalizeUser(item.user),
        port: normalizePort(item.port),
        transport: item.transport as SshProfileTransport,
        compatibility: item.compatibility as SshProfileCompatibility,
        ...(typeof item.credentialId === "string" && ID_PATTERN.test(item.credentialId) ? { credentialId: item.credentialId } : {}),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    } catch {
      // Ignore corrupt legacy records.
    }
  }
  return { version: 1, records };
}

export interface SaveSshProfileInput {
  id?: string;
  name: string;
  host: string;
  user: string;
  port?: number;
  transport?: SshProfileTransport;
  compatibility?: SshProfileCompatibility;
  credentialId?: string;
}

export async function saveSshProfile(input: SaveSshProfileInput): Promise<SshServerProfile> {
  const name = input.name.trim();
  if (!name) throw new Error("SSH profile name is required.");
  const requestedId = input.id?.trim().toLowerCase();
  const baseId = requestedId || slugify(name);
  if (!ID_PATTERN.test(baseId)) throw new Error("SSH profile id must be a lowercase slug.");
  const credentialId = input.credentialId?.trim().toLowerCase();
  if (credentialId && !ID_PATTERN.test(credentialId)) throw new Error("SSH credential id must be a lowercase slug.");

  let saved!: SshServerProfile;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    const existing = current.records[baseId];
    const now = new Date().toISOString();
    saved = {
      id: baseId,
      name,
      host: normalizeHost(input.host),
      user: normalizeUser(input.user),
      port: normalizePort(input.port ?? 22),
      transport: input.transport ?? "auto",
      compatibility: input.compatibility ?? "auto",
      ...(credentialId ? { credentialId } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return { [STORE_KEY]: { version: 1, records: { ...current.records, [baseId]: saved } } };
  });
  return saved;
}

export async function getSshProfile(id: string): Promise<SshServerProfile | null> {
  const state = await readAppState();
  return parseState(state[STORE_KEY]).records[id.trim().toLowerCase()] ?? null;
}

export async function listSshProfiles(): Promise<SshServerProfile[]> {
  const state = await readAppState();
  return Object.values(parseState(state[STORE_KEY]).records).sort((a, b) => a.name.localeCompare(b.name));
}

export async function removeSshProfile(id: string): Promise<boolean> {
  const key = id.trim().toLowerCase();
  let removed = false;
  await updateAppState((state) => {
    const current = parseState(state[STORE_KEY]);
    if (!current.records[key]) return { [STORE_KEY]: current };
    const records = { ...current.records };
    delete records[key];
    removed = true;
    return { [STORE_KEY]: { version: 1, records } };
  });
  return removed;
}

export async function updateSshProfile(id: string, patch: Partial<Omit<SaveSshProfileInput, "id">>): Promise<SshServerProfile> {
  const existing = await getSshProfile(id);
  if (!existing) throw new Error("SSH profile not found.");
  return saveSshProfile({
    id: existing.id,
    name: patch.name ?? existing.name,
    host: patch.host ?? existing.host,
    user: patch.user ?? existing.user,
    port: patch.port ?? existing.port,
    transport: patch.transport ?? existing.transport,
    compatibility: patch.compatibility ?? existing.compatibility,
    credentialId: patch.credentialId === undefined ? existing.credentialId : patch.credentialId,
  });
}

export function sshProfileFingerprint(profile: Pick<SshServerProfile, "host" | "user" | "port">): string {
  return createHash("sha256").update(profile.host).update("\0").update(profile.user).update("\0").update(String(profile.port)).digest("hex").slice(0, 16);
}
