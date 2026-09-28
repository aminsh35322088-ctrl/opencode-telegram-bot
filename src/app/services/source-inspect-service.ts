import {
  isAllowedGitHubUrl,
  parseGitHubSkillUrl,
  resolveSkillSource,
} from "./skill-import-service.js";
import { validatePluginSpecifier } from "./extension-ensure-service.js";
import { analyzeRemoteMcpEndpoint } from "./mcp-server-service.js";
import { logger } from "../../utils/logger.js";

const GITHUB_API_URL = "https://api.github.com";
const MAX_LISTED_ENTRIES = 200;
const PROBE_TIMEOUT_MS = 12_000;

export type InspectedSourceKind = "skill" | "plugin" | "mcp" | "unknown";

export interface InspectedSource {
  url: string;
  kind: InspectedSourceKind;
  /** Human-facing name the bot would install under. */
  name?: string;
  description?: string;
  /** Ready-to-use specifier or URL, depending on kind. */
  specifier?: string;
  /** Server-reported tags/versions or other provenance worth showing. */
  meta?: Record<string, string | number | boolean>;
  /** Why detection stopped short, when the kind is unknown. */
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, 100);
  return trimmed || undefined;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "opencode-telegram-bot",
    },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub responded with HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * A repo is treated as an OpenCode plugin when it ships the OpenCode plugin
 * entrypoint. This is the same signal the user already relies on when pinning
 * `pkg@git+https://...#<tag>`, so detection and installation cannot disagree.
 */
function looksLikeOpenCodePlugin(root: Record<string, unknown>[]): boolean {
  return root.some((entry) => {
    const name = typeof entry.name === "string" ? entry.name.toLowerCase() : "";
    if (entry.type !== "file" && entry.type !== "dir") return false;
    if (name === "package.json" || name === "opencode.json") return true;
    return name === ".opencode" || name === ".opencode-plugin";
  });
}

function describeRepositoryPackage(pkg: Record<string, unknown>): { name?: string; description?: string } {
  return { name: safeName(pkg.name), description: safeName(pkg.description) };
}

async function inspectGitHubRepository(
  url: string,
  parsed: NonNullable<ReturnType<typeof parseGitHubSkillUrl>>,
): Promise<InspectedSource> {
  const branch = parsed.ref ?? "HEAD";
  const listingUrl = `${GITHUB_API_URL}/repos/${parsed.owner}/${parsed.repo}/contents?ref=${encodeURIComponent(branch)}`;
  const entries = await fetchJson(listingUrl);
  if (!Array.isArray(entries)) {
    return { url, kind: "unknown", note: "Repository contents could not be listed." };
  }
  const root = entries.filter(isRecord).slice(0, MAX_LISTED_ENTRIES);

  // Plugin wins over Skill: a repository can ship both, and a pinned plugin
  // install already brings every skill it contains.
  if (looksLikeOpenCodePlugin(root)) {
    let description: string | undefined;
    const packageEntry = root.find((entry) => entry.name === "package.json");
    if (packageEntry?.type === "file" && typeof packageEntry.url === "string") {
      const pkg = await fetchJson(packageEntry.url).catch(() => null);
      if (isRecord(pkg)) ({ description } = describeRepositoryPackage(pkg));
    }
    // The ref must be immutable: the install path rejects branches anyway, so
    // report the default branch the user has to pin explicitly.
    const resolved = await fetchJson(
      `${GITHUB_API_URL}/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(branch)}`,
    ).catch(() => null);
    const sha = isRecord(resolved) && typeof resolved.sha === "string" ? resolved.sha : undefined;
    return {
      url,
      kind: "plugin",
      name: parsed.repo,
      ...(description ? { description } : {}),
      specifier: `${parsed.repo}@git+https://github.com/${parsed.owner}/${parsed.repo}.git#${sha ?? "HEAD"}`,
      meta: {
        owner: parsed.owner,
        repository: parsed.repo,
        ...(sha ? { commit: sha } : {}),
        branch,
      },
      ...(sha ? {} : { note: "Could not resolve a commit; pin a tag or commit before installing." }),
    };
  }

  const resolution = await resolveSkillSource(url).catch((error) => {
    logger.debug("[SourceInspect] Skill resolution failed", error instanceof Error ? error.message : String(error));
    return null;
  });
  if (resolution?.kind === "single") {
    return {
      url,
      kind: "skill",
      name: resolution.skill.name,
      ...(resolution.skill.description ? { description: resolution.skill.description } : {}),
      specifier: url,
    };
  }
  if (resolution?.kind === "list") {
    return {
      url,
      kind: "skill",
      name: parsed.repo,
      description: `Repository contains ${resolution.candidates.length} skills: ${resolution.candidates.map((c) => c.name).join(", ")}`,
      meta: { skillCount: resolution.candidates.length },
      note: "Import a specific skill by passing its folder URL.",
    };
  }

  return {
    url,
    kind: "unknown",
    name: parsed.repo,
    note: "No OpenCode plugin manifest and no SKILL.md were found.",
  };
}

async function inspectMcpEndpoint(url: string): Promise<InspectedSource> {
  const analysis = await analyzeRemoteMcpEndpoint(url).catch((error) => {
    logger.debug("[SourceInspect] MCP probe failed", error instanceof Error ? error.message : String(error));
    return null;
  });
  if (!analysis?.reachable) {
    return {
      url,
      kind: "mcp",
      note: analysis?.note ?? "MCP endpoint is not reachable, so it cannot be verified.",
    };
  }
  return {
    url,
    kind: "mcp",
    specifier: url,
    meta: {
      status: analysis.status ?? 0,
      auth: analysis.authHint,
    },
    description: analysis.authHint === "oauth-likely"
      ? "Reachable MCP endpoint advertising OAuth. Sign-in is required after install."
      : analysis.authHint === "credential-likely"
        ? "Reachable MCP endpoint that likely needs an API key or bearer token."
        : analysis.note,
  };
}

function inspectSpecifier(value: string): InspectedSource | null {
  try {
    const specifier = validatePluginSpecifier(value);
    return { url: value, kind: "plugin", name: specifier.split("@")[0], specifier, meta: { pinned: true } };
  } catch {
    return null;
  }
}

/**
 * Classifies a user-supplied source so the model can describe it and ask for
 * confirmation before anything is installed. Read-only: this never writes bot
 * state, and every probe is bounded by a timeout.
 */
export async function inspectExtensionSource(value: string): Promise<InspectedSource> {
  const raw = value.trim();
  if (!raw) throw new Error("A source URL or plugin specifier is required.");

  // Explicit package specifiers are unambiguous, so validate them directly.
  const specifier = inspectSpecifier(raw);
  if (specifier) return specifier;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(raw);
  } catch {
    return {
      url: raw,
      kind: "unknown",
      note: "Not a valid URL or pinned plugin specifier. Use a GitHub link, an HTTP(S) MCP endpoint, or pkg@1.2.3 / pkg@git+https://…#<tag>.",
    };
  }

  if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
    if (isAllowedGitHubUrl(raw)) {
      const parsed = parseGitHubSkillUrl(raw);
      if (parsed) return inspectGitHubRepository(raw, parsed);
    }
    return inspectMcpEndpoint(raw);
  }

  return { url: raw, kind: "unknown", note: `Unsupported URL scheme "${parsedUrl.protocol.replace(":", "")}".` };
}
