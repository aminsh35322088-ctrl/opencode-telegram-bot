import { isValidSkillName } from "./skill-manage-service.js";
import { deriveSkillDescription } from "./skill-markdown.js";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_RAW_URL = "https://raw.githubusercontent.com";
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_PROBED_SUBDIRECTORIES = 15;

export interface SkillImportDeps {
  fetchFn?: typeof fetch;
}

export interface ImportedSkill {
  name: string;
  description: string;
  content: string;
  sourceUrl: string;
}

export interface SkillImportCandidate {
  name: string;
  url: string;
}

export type SkillSourceResolution = { kind: "single"; skill: ImportedSkill } | { kind: "list"; candidates: SkillImportCandidate[] };

export interface ParsedGitHubSkillUrl {
  owner: string;
  repo: string;
  ref?: string | undefined;
  subpath?: string | undefined;
  isRaw: boolean;
}

const GITHUB_PAGE_URL = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?(?:\/([^/?#]+)\/([^/?#]+)(?:\/([^?#]*))?)?\/?(?:[?#].*)?$/u;
const GITHUB_RAW_URL_PATTERN = /^https:\/\/raw\.githubusercontent\.com\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^?#]*?)\/?$/u;

function safeSegment(value: string): string | undefined {
  const decoded = decodeURIComponent(value);
  if (!decoded || decoded.includes("..") || decoded.includes("/") || decoded.includes("\\")) {
    return undefined;
  }
  return decoded;
}

function buildSubpath(segments: string[]): string | undefined {
  const decoded: string[] = [];
  for (const segment of segments) {
    const value = safeSegment(segment);
    if (value === undefined) {
      return undefined;
    }
    if (value.length > 0) {
      decoded.push(value);
    }
  }
  return decoded.length > 0 ? decoded.join("/") : undefined;
}

export function isAllowedGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" && (parsed.hostname === "github.com" || parsed.hostname === "raw.githubusercontent.com");
  } catch {
    return false;
  }
}

export function parseGitHubSkillUrl(url: string): ParsedGitHubSkillUrl | null {
  const value = url.trim();
  if (!isAllowedGitHubUrl(value)) {
    return null;
  }

  const raw = GITHUB_RAW_URL_PATTERN.exec(value);
  if (raw?.[1] && raw[2] && raw[3] && raw[4] !== undefined) {
    const owner = safeSegment(raw[1]);
    const repo = safeSegment(raw[2]);
    const ref = safeSegment(raw[3]);
    const subpath = buildSubpath(raw[4].split("/"));
    if (!owner || !repo || !ref) {
      return null;
    }
    return { owner, repo, ref, subpath, isRaw: true };
  }

  const page = GITHUB_PAGE_URL.exec(value);
  if (!page?.[1] || !page[2]) {
    return null;
  }

  const owner = safeSegment(page[1]);
  const repo = safeSegment(page[2]);
  if (!owner || !repo) {
    return null;
  }

  if (!page[3]) {
    return { owner, repo, ref: undefined, subpath: undefined, isRaw: false };
  }

  if ((page[3] !== "tree" && page[3] !== "blob") || !page[4]) {
    return null;
  }

  const ref = safeSegment(page[4]);
  const subpath = page[5] !== undefined ? buildSubpath(page[5].split("/")) : undefined;
  const invalidPath = page[5] !== undefined && page[5].length > 0 && subpath === undefined;
  if (!ref || invalidPath) {
    return null;
  }
  return { owner, repo, ref, subpath, isRaw: false };
}

async function fetchText(fetchFn: typeof fetch, url: string, accept: string): Promise<{ ok: boolean; status: number; text: string }> {
  const response = await fetchFn(url, {
    headers: { Accept: accept, "User-Agent": "opencode-telegram-bot" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function fetchJson<T>(fetchFn: typeof fetch, url: string): Promise<T> {
  const response = await fetchText(fetchFn, url, "application/vnd.github+json");
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }
  return JSON.parse(response.text) as T;
}

interface GitHubContentsEntry {
  name?: string;
  path?: string;
  type?: string;
}

function rawFileUrl(owner: string, repo: string, rev: string, path: string): string {
  return `${GITHUB_RAW_URL}/${owner}/${repo}/${encodeURIComponent(rev)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function pathDirName(path: string): string | undefined {
  const segments = path.split("/");
  return segments.length > 1 ? segments[segments.length - 2] : undefined;
}

function toImportedSkill(url: string, path: string, content: string): ImportedSkill {
  if (content.length > MAX_SKILL_FILE_BYTES) {
    throw new Error("The skill file is too large (max 256 KB)");
  }
  if (!content.trim()) {
    throw new Error("The skill file is empty");
  }

  const derived = deriveSkillDescription(content);
  const frontmatter = /^[ \t]*name[ \t]*:[ \t]*"?([a-z0-9][a-z0-9-]*)"?/imu.exec(content)?.[1];
  const candidates = [pathDirName(path), frontmatter];
  const name = candidates.find((value): value is string => Boolean(value && isValidSkillName(value)));
  if (!name) {
    throw new Error("The skill name is invalid; use lowercase letters, digits and hyphens");
  }

  return { name, description: derived || `${name} skill`, content, sourceUrl: url };
}

async function resolveRefToSha(fetchFn: typeof fetch, owner: string, repo: string, ref: string): Promise<string> {
  const data = await fetchJson<{ sha?: string }>(fetchFn, `${GITHUB_API_URL}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
  if (!data.sha) {
    throw new Error("GitHub did not return a commit for this ref");
  }
  return data.sha;
}

async function resolveDefaultBranch(fetchFn: typeof fetch, owner: string, repo: string): Promise<string> {
  const data = await fetchJson<{ default_branch?: string }>(fetchFn, `${GITHUB_API_URL}/repos/${owner}/${repo}`);
  if (!data.default_branch) {
    throw new Error("GitHub did not return a default branch");
  }
  return data.default_branch;
}

async function locateSkillFile(
  fetchFn: typeof fetch,
  owner: string,
  repo: string,
  sha: string,
  subpath: string | undefined,
): Promise<{ path: string; text: string }> {
  const tryPath = async (candidate: string): Promise<{ path: string; text: string } | null> => {
    const response = await fetchText(fetchFn, rawFileUrl(owner, repo, sha, candidate), "text/plain");
    if (response.ok && response.text) {
      return { path: candidate, text: response.text };
    }
    return null;
  };

  if (subpath?.toLowerCase().endsWith("skill.md")) {
    const found = await tryPath(subpath);
    if (!found) {
      throw new Error(`No SKILL.md found at ${subpath}`);
    }
    return found;
  }

  const direct = subpath ? await tryPath(`${subpath}/SKILL.md`) : await tryPath("SKILL.md");
  if (direct) {
    return direct;
  }

  const listingPath = subpath ? `/contents/${subpath}` : "/contents";
  const entries = await fetchJson<GitHubContentsEntry[]>(
    fetchFn,
    `${GITHUB_API_URL}/repos/${owner}/${repo}${listingPath}?ref=${encodeURIComponent(sha)}`,
  ).catch((): GitHubContentsEntry[] => []);
  const skillEntry = Array.isArray(entries) ? entries.find((entry) => entry.type === "file" && entry.name?.toLowerCase() === "skill.md") : undefined;
  if (skillEntry?.path) {
    const found = await tryPath(skillEntry.path);
    if (found) {
      return found;
    }
  }

  throw new Error("No SKILL.md found in this location");
}

export async function fetchSkillFromGitHub(url: string, deps: SkillImportDeps = {}): Promise<ImportedSkill> {
  const parsed = parseGitHubSkillUrl(url);
  if (!parsed) {
    throw new Error("This is not a valid GitHub repository or skill link");
  }
  const fetchFn = deps.fetchFn ?? fetch;

  let rev: string;
  if (parsed.isRaw) {
    if (!parsed.ref || !parsed.subpath) {
      throw new Error("This is not a valid GitHub raw file link");
    }
    rev = parsed.ref;
  } else {
    const ref = parsed.ref ?? (await resolveDefaultBranch(fetchFn, parsed.owner, parsed.repo));
    rev = await resolveRefToSha(fetchFn, parsed.owner, parsed.repo, ref);
  }

  const located = await locateSkillFile(fetchFn, parsed.owner, parsed.repo, rev, parsed.subpath);
  return toImportedSkill(url, located.path, located.text);
}

export async function resolveSkillSource(url: string, deps: SkillImportDeps = {}): Promise<SkillSourceResolution> {
  try {
    const skill = await fetchSkillFromGitHub(url, deps);
    return { kind: "single", skill };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("No SKILL.md found")) {
      throw error;
    }

    const parsed = parseGitHubSkillUrl(url);
    if (!parsed || parsed.isRaw) {
      throw error;
    }
    const fetchFn = deps.fetchFn ?? fetch;
    const ref = parsed.ref ?? (await resolveDefaultBranch(fetchFn, parsed.owner, parsed.repo));
    const sha = await resolveRefToSha(fetchFn, parsed.owner, parsed.repo, ref);
    const listingPath = parsed.subpath ? `/contents/${parsed.subpath}` : "/contents";
    const entries = await fetchJson<GitHubContentsEntry[]>(
      fetchFn,
      `${GITHUB_API_URL}/repos/${parsed.owner}/${parsed.repo}${listingPath}?ref=${encodeURIComponent(sha)}`,
    );
    if (!Array.isArray(entries)) {
      throw error;
    }

    const candidates: SkillImportCandidate[] = [];
    const directories = entries.filter((entry) => entry.type === "dir" && entry.name && entry.path).slice(0, MAX_PROBED_SUBDIRECTORIES);
    for (const directory of directories) {
      const listing = await fetchJson<GitHubContentsEntry[]>(
        fetchFn,
        `${GITHUB_API_URL}/repos/${parsed.owner}/${parsed.repo}/contents/${directory.path}?ref=${encodeURIComponent(sha)}`,
      ).catch((): GitHubContentsEntry[] => []);
      const hasSkill = Array.isArray(listing) && listing.some((entry) => entry.type === "file" && entry.name?.toLowerCase() === "skill.md");
      if (hasSkill) {
        candidates.push({
          name: directory.name as string,
          url: `https://github.com/${parsed.owner}/${parsed.repo}/tree/${ref}/${directory.path}`,
        });
      }
    }

    if (candidates.length === 0) {
      throw error;
    }
    return { kind: "list", candidates: candidates.sort((left, right) => left.name.localeCompare(right.name)) };
  }
}
