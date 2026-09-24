const FORCE_PUSH_PREFIX = "--force";

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  "credentials",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "secrets.json",
]);

const SENSITIVE_EXTENSIONS = new Set([".key", ".p12", ".pem", ".pfx"]);

/**
 * Split a shell-like argument string without invoking a shell. Single-quoted
 * segments are literal, double-quoted segments honour backslash escapes, and
 * backslashes outside quotes are preserved so paths and regexes survive.
 */
export function parseShellLikeArgs(input?: string): string[] {
  const value = input?.trim();
  if (!value) return [];

  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (quote === '"') {
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("Unclosed quote in arguments.");
  if (current) result.push(current);
  return result;
}

/**
 * Detect force-push flags on an already-parsed argument list so callers can
 * refuse force pushes instead of silently rewriting remote history.
 */
export function containsForcePushFlag(args: string[]): boolean {
  return args.some((arg) => arg === "-f" || arg.startsWith(FORCE_PUSH_PREFIX));
}

/**
 * Identify environment and credential files that must not be read through the
 * generic file tool without an explicit override.
 */
export function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const basename = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (!basename) return false;
  if (SENSITIVE_BASENAMES.has(basename)) return true;
  if (basename.startsWith(".env.")) return true;
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0) return false;
  return SENSITIVE_EXTENSIONS.has(basename.slice(dotIndex));
}