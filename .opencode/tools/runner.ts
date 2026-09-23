import { tool } from "@opencode-ai/plugin";

const RUNNER_BRIDGE_URL = "http://127.0.0.1:3000/internal/runner/action";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;

function normalizeTimeout(value: unknown): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 1_000), MAX_TIMEOUT_MS);
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export default tool({
  description:
    "Use the live GitHub Runner Lab machine for remote coding work. Supports status, bounded command execution, detached jobs, file read/write/list/search, workspace preparation, and project validation. This tool targets the currently connected Runner Lab generation and survives runner rotation through the lab's existing checkpoint/handoff system.",
  args: {
    action: tool.schema
      .string()
      .describe(
        "One of: status | exec | job.start | job.status | job.logs | job.wait | job.stop | file.read | file.write | file.list | file.search | workspace.prepare | validate",
      ),
    command: tool.schema.string().optional().describe("Shell command for exec or job.start."),
    cwd: tool.schema.string().optional().describe("Working directory on the runner."),
    timeoutMs: tool.schema
      .number()
      .optional()
      .describe("Bounded action timeout in milliseconds, capped at 15 minutes."),
    jobId: tool.schema.string().optional().describe("Detached runner job id for job.status/job.logs/job.wait/job.stop."),
    path: tool.schema.string().optional().describe("Remote path for file operations."),
    content: tool.schema.string().optional().describe("File content for file.write."),
    query: tool.schema.string().optional().describe("Search query for file.search."),
    glob: tool.schema.string().optional().describe("Optional glob filter for file.search."),
    repo: tool.schema.string().optional().describe("Repository URL for workspace.prepare."),
    ref: tool.schema.string().optional().describe("Branch/tag/SHA for workspace.prepare."),
    pr: tool.schema.number().optional().describe("PR number for workspace.prepare."),
    mode: tool.schema
      .string()
      .optional()
      .describe("Validation mode: project (default), runner-quick, or runner-full."),
    limit: tool.schema.number().optional().describe("Result/output limit for list/search operations."),
  },
  async execute(args, context) {
    const action = clean(args.action)?.toLowerCase();
    if (!action) {
      return JSON.stringify({ ok: false, error: "action is required" }, null, 2);
    }

    const timeoutMs = normalizeTimeout(args.timeoutMs);
    const payloadArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (key === "action" || key === "timeoutMs" || value === undefined) continue;
      payloadArgs[key] = value;
    }
    payloadArgs.sessionId = context.sessionID;

    try {
      const response = await fetch(RUNNER_BRIDGE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, args: payloadArgs, timeoutMs }),
        signal: AbortSignal.any([context.abort, AbortSignal.timeout(timeoutMs + 10_000)]),
      });

      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok || payload.ok !== true) {
        return JSON.stringify(
          {
            ok: false,
            error:
              typeof payload.error === "string"
                ? payload.error
                : `runner bridge returned HTTP ${response.status}`,
          },
          null,
          2,
        );
      }

      return JSON.stringify({ ok: true, result: payload.result ?? null }, null, 2);
    } catch (error) {
      return JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          hint:
            "If the runner is rotating, retry after the successor Runner Lab generation reconnects.",
        },
        null,
        2,
      );
    }
  },
});
