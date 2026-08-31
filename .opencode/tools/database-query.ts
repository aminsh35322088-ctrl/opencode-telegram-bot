import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const READ_ONLY = /^(\s*(select|pragma|with|explain)\b)/i;

export default tool({
  description: "Run read-only SQL against a SQLite database file. Useful for schema inspection, debugging data, and verifying application state. Mutating SQL is deliberately rejected; use the normal shell/database integration for writes.",
  args: {
    database: tool.schema.string().describe("SQLite database path, absolute or relative to the worktree."),
    query: tool.schema.string().describe("Read-only SQL query (SELECT, PRAGMA, WITH, or EXPLAIN)."),
  },
  async execute(args, context) {
    if (!READ_ONLY.test(args.query)) throw new Error("database_query only permits read-only SELECT/PRAGMA/WITH/EXPLAIN statements.");
    const db = path.isAbsolute(args.database) ? path.normalize(args.database) : path.resolve(context.worktree, args.database);
    await fs.access(db);
    const { stdout, stderr } = await execFileAsync("sqlite3", ["-header", "-json", db, args.query], { cwd: context.worktree, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return `${stdout.trim()}${stderr.trim() ? `\n${stderr.trim()}` : ""}`.slice(0, 16000);
  },
});
