import {
  checkSshTarget,
  debugSshTarget,
  execSshCommand,
  runCommand,
  type SshCompatibility,
  type SshDebugDepth,
  type SshTransport,
} from "./ssh-service.js";
import { sshCredentialRunner } from "./ssh-auth-runner.js";
import {
  getSshProfile,
  listSshProfiles,
  removeSshProfile,
  saveSshProfile,
  updateSshProfile,
  type SaveSshProfileInput,
  type SshServerProfile,
} from "./ssh-profile-store.js";
import {
  listSshCredentialSummaries,
  loadSshCredential,
} from "./ssh-credential-store.js";
import { transferSshFile } from "./ssh-transfer-service.js";

export interface SshActionTarget {
  profileId?: string;
  host?: string;
  user?: string;
  port?: number;
  transport?: SshTransport;
  compatibility?: SshCompatibility;
  credentialId?: string;
  timeoutMs?: number;
}

interface ResolvedTarget {
  profile: SshServerProfile | null;
  host: string;
  user?: string;
  port: number;
  transport: SshTransport;
  compatibility: SshCompatibility;
  credentialId?: string;
  timeoutMs?: number;
}

function safeCredentialSummary(record: Awaited<ReturnType<typeof loadSshCredential>>): Record<string, unknown> | null {
  if (!record) return null;
  return {
    id: record.id,
    label: record.label,
    mode: record.mode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function resolveSshActionTarget(input: SshActionTarget, requireUser = false): Promise<ResolvedTarget> {
  const profileId = input.profileId?.trim().toLowerCase();
  if (profileId) {
    const profile = await getSshProfile(profileId);
    if (!profile) throw new Error(`SSH profile "${profileId}" was not found.`);
    if (input.host || input.user || input.port || input.transport || input.compatibility || input.credentialId) {
      throw new Error("When profileId is supplied, target/transport/credential overrides are not allowed. Update the profile instead.");
    }
    return {
      profile,
      host: profile.host,
      user: profile.user,
      port: profile.port,
      transport: profile.transport,
      compatibility: profile.compatibility,
      credentialId: profile.credentialId,
      timeoutMs: input.timeoutMs,
    };
  }

  const host = input.host?.trim() ?? "";
  if (!host) throw new Error("host or profileId is required.");
  const user = input.user?.trim();
  if (requireUser && !user) throw new Error("user is required for this SSH action.");
  return {
    profile: null,
    host,
    ...(user ? { user } : {}),
    port: input.port ?? 22,
    transport: input.transport ?? "auto",
    compatibility: input.compatibility ?? "auto",
    ...(input.credentialId?.trim() ? { credentialId: input.credentialId.trim().toLowerCase() } : {}),
    timeoutMs: input.timeoutMs,
  };
}

function publicTarget(target: ResolvedTarget): Record<string, unknown> {
  return {
    profileId: target.profile?.id ?? null,
    profileName: target.profile?.name ?? null,
    host: target.host,
    user: target.user ?? null,
    port: target.port,
    transport: target.transport,
    compatibility: target.compatibility,
    credentialId: target.credentialId ?? null,
  };
}

export async function sshProfilesList(): Promise<Record<string, unknown>> {
  const profiles = await listSshProfiles();
  return { ok: true, count: profiles.length, profiles };
}

export async function sshProfilesGet(id: string): Promise<Record<string, unknown>> {
  const profile = await getSshProfile(id);
  if (!profile) return { ok: false, error: "SSH profile not found.", profileId: id };
  const credential = profile.credentialId ? await loadSshCredential(profile.credentialId) : null;
  return { ok: true, profile, credential: safeCredentialSummary(credential) };
}

export async function sshProfilesCreate(input: SaveSshProfileInput): Promise<Record<string, unknown>> {
  if (input.credentialId) {
    const credential = await loadSshCredential(input.credentialId);
    if (!credential) throw new Error(`SSH credential "${input.credentialId}" was not found.`);
  }
  const profile = await saveSshProfile(input);
  return { ok: true, profile };
}

export async function sshProfilesUpdate(
  id: string,
  patch: Partial<Omit<SaveSshProfileInput, "id">>,
): Promise<Record<string, unknown>> {
  if (patch.credentialId) {
    const credential = await loadSshCredential(patch.credentialId);
    if (!credential) throw new Error(`SSH credential "${patch.credentialId}" was not found.`);
  }
  const profile = await updateSshProfile(id, patch);
  return { ok: true, profile };
}

export async function sshProfilesDelete(id: string): Promise<Record<string, unknown>> {
  const removed = await removeSshProfile(id);
  return { ok: removed, removed, profileId: id };
}

export async function sshCredentialsStatus(): Promise<Record<string, unknown>> {
  const credentials = await listSshCredentialSummaries();
  return {
    ok: true,
    count: credentials.length,
    credentials,
    note: "Credential values are encrypted at rest and are never returned to model-facing tools.",
  };
}

export async function sshTailnetStatus(): Promise<Record<string, unknown>> {
  const status = await runCommand({ bin: "/usr/local/bin/tailscale", args: ["status", "--json"], timeoutMs: 8_000 });
  if (!status.ok) return { ok: false, error: status.stderr || "tailscale status failed" };
  try {
    const parsed = JSON.parse(status.stdout) as {
      Self?: { HostName?: string; TailscaleIPs?: string[]; Online?: boolean; Tags?: string[] };
      Peer?: Record<string, { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean; Tags?: string[] }>;
    };
    return {
      ok: true,
      self: parsed.Self ? {
        hostName: parsed.Self.HostName,
        ips: parsed.Self.TailscaleIPs ?? [],
        online: parsed.Self.Online ?? null,
        tags: parsed.Self.Tags ?? [],
      } : null,
      peers: Object.values(parsed.Peer ?? {}).map((peer) => ({
        hostName: peer.HostName,
        dnsName: peer.DNSName,
        ips: peer.TailscaleIPs ?? [],
        online: peer.Online ?? null,
        tags: peer.Tags ?? [],
      })),
    };
  } catch {
    return { ok: false, error: "tailscale status returned invalid JSON." };
  }
}

export async function sshTailnetPing(target: string, timeoutMs = 8_000): Promise<Record<string, unknown>> {
  const host = target.trim();
  if (!host) throw new Error("tailnet.ping requires target.");
  const result = await runCommand({
    bin: "/usr/local/bin/tailscale",
    args: ["ping", "--timeout", `${Math.max(1, Math.min(Math.ceil(timeoutMs / 1000), 30))}s`, host],
    timeoutMs: Math.max(3_000, Math.min(timeoutMs + 2_000, 35_000)),
  });
  return {
    ok: result.ok,
    target: host,
    output: (result.stdout || result.stderr).trim().slice(0, 8000),
    timedOut: result.timedOut,
  };
}

export async function sshCheck(input: SshActionTarget): Promise<Record<string, unknown>> {
  const target = await resolveSshActionTarget(input, false);
  const runner = sshCredentialRunner(target.credentialId, runCommand);
  const result = await checkSshTarget(target, runner);
  return { target: publicTarget(target), ...result };
}

export async function sshDebug(input: SshActionTarget & { depth?: SshDebugDepth }): Promise<Record<string, unknown>> {
  const target = await resolveSshActionTarget(input, true);
  const runner = sshCredentialRunner(target.credentialId, runCommand);
  const result = await debugSshTarget({ ...target, depth: input.depth }, runner);
  return { target: publicTarget(target), ...result };
}

export async function sshExec(input: SshActionTarget & { command: string }): Promise<Record<string, unknown>> {
  const target = await resolveSshActionTarget(input, true);
  const runner = sshCredentialRunner(target.credentialId, runCommand);
  const result = await execSshCommand({ ...target, command: input.command }, runner);
  return { target: publicTarget(target), ...result };
}

export async function sshTransfer(
  input: SshActionTarget & { localPath: string; remotePath: string; direction: "upload" | "download" },
): Promise<Record<string, unknown>> {
  const target = await resolveSshActionTarget(input, true);
  const result = await transferSshFile({
    ...target,
    credentialId: target.credentialId,
    localPath: input.localPath,
    remotePath: input.remotePath,
    direction: input.direction,
  }, runCommand);
  return { target: publicTarget(target), ...result };
}
