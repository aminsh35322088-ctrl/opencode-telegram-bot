import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

export default tool({
  description: "File operations: read, write, search (glob), grep (content search), info, delete, copy, move. Works within the worktree.",
  args: {
    action: tool.schema.enum(["read", "write", "search", "grep", "info", "delete", "copy", "move"]).describe("File operation to execute."),
    path: tool.schema.string().describe("File or directory path relative to worktree."),
    content: tool.schema.string().optional().describe("Content to write (for write action)."),
    pattern: tool.schema.string().optional().describe("Glob pattern for search, regex for grep, or destination for copy/move."),
  },
  async execute(args, context) {
    const { action, path: filePath, content, pattern } = args;
    const worktree = context.worktree;
    const fullPath = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(worktree, filePath);

    switch (action) {
      case "read": {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          const entries = await fs.readdir(fullPath);
          return entries.join("\n");
        }
        const data = await fs.readFile(fullPath, "utf-8");
        return data.slice(0, 16000);
      }
      case "write": {
        if (!content) throw new Error("Content required for write action");
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, "utf-8");
        return `Written ${content.length} bytes to ${filePath}`;
      }
      case "search": {
        if (!pattern) throw new Error("Glob pattern required for search. Example: pattern=\"**/*.ts\"");
        try {
          const { stdout } = await execFileAsync("find", [fullPath, "-name", pattern, "-type", "f"], {
            cwd: worktree,
            timeout: 10000,
          });
          return stdout.trim() || "No files found";
        } catch {
          const entries: string[] = [];
          const walk = async (dir: string): Promise<void> => {
            const items = await fs.readdir(dir, { withFileTypes: true });
            for (const item of items) {
              const itemPath = path.join(dir, item.name);
              if (item.isDirectory()) {
                await walk(itemPath);
              } else if (item.name.match(pattern.replace(/\*/g, ".*").replace(/\?/g, "."))) {
                entries.push(path.relative(worktree, itemPath));
              }
            }
          };
          await walk(fullPath);
          return entries.join("\n") || "No files found";
        }
      }
      case "grep": {
        if (!pattern) throw new Error("Regex pattern required for grep. Example: pattern=\"function\\s+\\w+\"");
        try {
          const { stdout } = await execFileAsync("grep", ["-rn", pattern, fullPath], {
            cwd: worktree,
            timeout: 30000,
            maxBuffer: 4 * 1024 * 1024,
          });
          return stdout.trim().slice(0, 16000) || "No matches found";
        } catch (error) {
          const e = error as { code?: number };
          if (e.code === 1) return "No matches found";
          throw new Error("Grep failed. Ensure the path exists and is accessible.");
        }
      }
      case "info": {
        const stat = await fs.stat(fullPath);
        return JSON.stringify({
          path: filePath,
          size: stat.size,
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          isDirectory: stat.isDirectory(),
          isFile: stat.isFile(),
          permissions: stat.mode.toString(8).slice(-3),
        }, null, 2);
      }
      case "delete": {
        await fs.rm(fullPath, { recursive: true, force: true });
        return `Deleted ${filePath}`;
      }
      case "copy": {
        if (!pattern) throw new Error("Destination path required for copy. Example: pattern=\"backup/file.ts\"");
        const dest = path.isAbsolute(pattern) ? path.normalize(pattern) : path.resolve(worktree, pattern);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.cp(fullPath, dest, { recursive: true });
        return `Copied ${filePath} to ${pattern}`;
      }
      case "move": {
        if (!pattern) throw new Error("Destination path required for move. Example: pattern=\"new-name.ts\"");
        const dest = path.isAbsolute(pattern) ? path.normalize(pattern) : path.resolve(worktree, pattern);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(fullPath, dest);
        return `Moved ${filePath} to ${pattern}`;
      }
      default:
        throw new Error(`Unknown file action: ${action}`);
    }
  },
});
