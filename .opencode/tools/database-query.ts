import type { ToolProcessPort } from "@opencode-telegram/native-runtime";
import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const READ_ONLY = /^(\s*(select|pragma|with|explain)\b)/i;

export default tool({
  description: "Run read-only SQL against a SQLite database file through the explicit query action. Mutating SQL is deliberately rejected; use the normal shell/database integration for writes.",
  args: {
    action: tool.schema.enum(["query"]).describe("Database action to execute."),
    database: tool.schema.string().describe("SQLite database path, absolute or relative to the worktree."),
    query: tool.schema.string().describe("Read-only SQL query (SELECT, PRAGMA, WITH, or EXPLAIN)."),
  },
  async execute(args, context) {
    const processPort = (context as typeof context & { process?: ToolProcessPort }).process;
    if (!processPort) throw new Error("Core process capability is required for tool ownership.");
    const base = context.directory || context.worktree || process.cwd();
    if (!READ_ONLY.test(args.query)) throw new Error("database_query only permits read-only SELECT/PRAGMA/WITH/EXPLAIN statements.");
    const db = path.isAbsolute(args.database) ? path.normalize(args.database) : path.resolve(base, args.database);
    await fs.access(db);
    try {
      const { stdout, stderr } = await processPort.execFile("sqlite3", ["-header", "-json", db, args.query], { cwd: base, signal: context.abort, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      return `${stdout.trim()}${stderr.trim() ? `\n${stderr.trim()}` : ""}`.slice(0, 16000);
    } catch (error) {
      const e = error as { stderr?: string; message?: string; code?: string | number };
      if (e.code === "ENOENT") throw new Error("sqlite3 is not installed. Install it with: apt-get install sqlite3");
      throw new Error(e.stderr || e.message || "Database query failed");
    }
  },
});
