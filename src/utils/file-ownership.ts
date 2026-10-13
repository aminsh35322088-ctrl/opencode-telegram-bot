/**
 * Ownership and permission predicates for files this process just wrote itself.
 *
 * Windows has no POSIX DAC: `lstat().mode` is synthesized as `0o666` even for a
 * file created with mode `0o600`, and `process.getuid` does not exist at all.
 * Both comparisons therefore reject every legitimately written file there and
 * make the store unreadable for ever. The type, symlink and size checks still
 * run on every platform; only the ownership and mode predicates — which carry
 * no meaning on Windows — are skipped there. On every other platform these
 * helpers return exactly what the inline expressions returned before.
 */

/** `true` when the file grants no group/other access. */
export function isRestrictiveMode(mode: number): boolean {
  if (process.platform === "win32") return true;
  return (mode & 0o077) === 0;
}

/** `true` when the file is owned by the current process identity. */
export function isOwnUser(uid: number): boolean {
  const current = process.getuid?.();
  if (current === undefined) return true;
  return uid === current;
}

/** `true` when the file is owned by root. */
export function isRootUser(uid: number): boolean {
  if (process.platform === "win32") return true;
  return uid === 0;
}
