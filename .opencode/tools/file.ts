import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const MAX_OUTPUT_CHARS = 16000;
const MAX_RESULTS = 2000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveInside(worktree: string, raw: string, label: string): string {
  if (!raw.trim()) throw new Error(`${label} is required`);
  if (path.isAbsolute(raw)) throw new Error(`${label} must be relative to the current worktree.`);
  const root = path.resolve(worktree);
  const target = path.resolve(root, raw);
  if (!inside(root, target)) throw new Error(`${label} must stay inside the current worktree.`);
  return target;
}

async function assertRealpathInside(worktree: string, target: string): Promise<string> {
  const root = await fs.realpath(path.resolve(worktree)).catch(() => path.resolve(worktree));
  const realTarget = await fs.realpath(target);
  if (!inside(root, realTarget)) throw new Error("Resolved path escapes the current worktree through a symlink.");
  return realTarget;
}

async function assertDestinationInside(worktree: string, target: string): Promise<void> {
  const root = await fs.realpath(path.resolve(worktree)).catch(() => path.resolve(worktree));
  let cursor = target;
  while (true) {
    try {
      const real = await fs.realpath(cursor);
      if (!inside(root, real)) throw new Error("Destination escapes the current worktree through a symlink.");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error("Could not resolve a safe destination parent.");
      cursor = parent;
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  let output = "^";
  const normalized = pattern.replaceAll("\\", "/");
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        output += "(?:.*/)?";
        index += 2;
      } else {
        output += ".*";
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      output += "[^/]*";
      continue;
    }
    if (char === "?") {
      output += "[^/]";
      continue;
    }
    output += /[.+^$(){}|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${output}$`);
}

async function collectFiles(root: string, pattern?: RegExp): Promise<string[]> {
  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (results.length >= MAX_RESULTS) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) break;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const relative = path.relative(root, full).replaceAll(path.sep, "/");
        if (!pattern || pattern.test(relative) || pattern.test(entry.name)) results.push(full);
      }
    }
  };
  await walk(root);
  return results;
}

export default tool({
  description: "Bounded file operations inside the current git worktree: read, write, search, grep, info, delete, copy, and move. Absolute paths and worktree escapes are rejected.",
  args: {
    action: tool.schema.enum(["read", "write", "search", "grep", "info", "delete", "copy", "move"]).describe("File operation to execute."),
    path: tool.schema.string().describe("File or directory path relative to the current worktree."),
    content: tool.schema.string().optional().describe("Content for write. Empty strings are allowed."),
    pattern: tool.schema.string().optional().describe("Glob for search, regex for grep, or destination path for copy/move."),
  },
  async execute(args, context) {
    const worktree = path.resolve(context.worktree);
    const requested = resolveInside(worktree, args.path, "path");

    if (args.action === "write") {
      if (args.content === undefined) throw new Error("write requires content (an empty string is valid).");
      await assertDestinationInside(worktree, requested);
      await fs.mkdir(path.dirname(requested), { recursive: true });
      await fs.writeFile(requested, args.content, "utf8");
      return `Written ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`;
    }

    if (args.action === "copy" || args.action === "move") {
      if (!args.pattern?.trim()) throw new Error(`${args.action} requires pattern as a destination path.`);
      const source = await assertRealpathInside(worktree, requested);
      const destination = resolveInside(worktree, args.pattern, "destination");
      await assertDestinationInside(worktree, destination);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (args.action === "copy") await fs.cp(source, destination, { recursive: true, errorOnExist: false });
      else await fs.rename(source, destination);
      return `${args.action === "copy" ? "Copied" : "Moved"} ${args.path} to ${args.pattern}`;
    }

    const fullPath = await assertRealpathInside(worktree, requested);

    if (args.action === "read") {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        const entries = (await fs.readdir(fullPath)).sort((a, b) => a.localeCompare(b));
        return entries.join("\n").slice(0, MAX_OUTPUT_CHARS);
      }
      return (await fs.readFile(fullPath, "utf8")).slice(0, MAX_OUTPUT_CHARS);
    }

    if (args.action === "info") {
      const stat = await fs.stat(fullPath);
      return JSON.stringify({
        path: path.relative(worktree, fullPath) || ".",
        size: stat.size,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString(),
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        permissions: stat.mode.toString(8).slice(-3),
      }, null, 2);
    }

    if (args.action === "delete") {
      if (path.resolve(fullPath) === worktree) throw new Error("Refusing to delete the worktree root.");
      await fs.rm(fullPath, { recursive: true, force: false });
      return `Deleted ${args.path}`;
    }

    if (args.action === "search") {
      if (!args.pattern?.trim()) throw new Error('search requires a glob pattern, for example "**/*.ts".');
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) throw new Error("search path must be a directory.");
      const matcher = globToRegExp(args.pattern);
      const files = await collectFiles(fullPath, matcher);
      const output = files.map((file) => path.relative(worktree, file)).join("\n");
      return output || "No files found";
    }

    if (args.action === "grep") {
      if (!args.pattern?.trim()) throw new Error("grep requires a regular-expression pattern.");
      let matcher: RegExp;
      try {
        matcher = new RegExp(args.pattern);
      } catch (error) {
        throw new Error(`Invalid grep regex: ${(error as Error).message}`);
      }
      const stat = await fs.stat(fullPath);
      const files = stat.isDirectory() ? await collectFiles(fullPath) : [fullPath];
      const matches: string[] = [];
      for (const file of files) {
        if (matches.join("\n").length >= MAX_OUTPUT_CHARS) break;
        let text: string;
        try {
          text = await fs.readFile(file, "utf8");
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          if (matcher.test(lines[index] ?? "")) {
            matches.push(`${path.relative(worktree, file)}:${index + 1}:${lines[index]}`);
            if (matches.join("\n").length >= MAX_OUTPUT_CHARS) break;
          }
        }
      }
      return matches.join("\n").slice(0, MAX_OUTPUT_CHARS) || "No matches found";
    }

    throw new Error(`Unknown file action: ${args.action}`);
  },
});
