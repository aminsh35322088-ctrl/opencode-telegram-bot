import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);
const GH_BIN = "gh";
const GH_CALL_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 10_000;
const DEFAULT_WATCH_BUDGET_MS = 90_000;
const MAX_WATCH_BUDGET_MS = 240_000;
const MAX_OUTPUT = 16_000;
const RUN_JSON_FIELDS =
  "databaseId,name,status,conclusion,headBranch,headSha,displayTitle,url,event";

interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RunSummary {
  databaseId?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  headBranch?: string;
  headSha?: string;
  displayTitle?: string;
  url?: string;
  event?: string;
}

interface FailedLogsResult {
  ok: boolean;
  logs: string;
  error?: string;
}

async function gh(args: string[], timeoutMs = GH_CALL_TIMEOUT_MS): Promise<GhResult> {
  try {
    const { stdout, stderr } = await execFileAsync(GH_BIN, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    return { ok: true, stdout, stderr, timedOut: false };
  } catch (error) {
    const e = error as {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
      message?: string;
    };
    const timedOut = Boolean(e.killed) || e.signal === "SIGTERM";
    const stderr = timedOut
      ? `gh ${args.join(" ")} timed out after ${timeoutMs}ms`
      : (e.stderr || e.message || String(error)).trim();
    return { ok: false, stdout: e.stdout ?? "", stderr, timedOut };
  }
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT
    ? `…(truncated, ${text.length} chars total)\n${text.slice(-MAX_OUTPUT)}`
    : text;
}

function parseRuns(stdout: string): RunSummary[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as RunSummary[]) : [];
  } catch {
    return [];
  }
}

function parseRun(stdout: string): RunSummary | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as RunSummary;
  } catch {
    return null;
  }
}

function sameCommit(actual: string | undefined, requested: string): boolean {
  if (!actual) return false;
  return actual === requested || actual.startsWith(requested) || requested.startsWith(actual);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function result(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

async function failedLogs(runId: string, repoArgs: string[] = []): Promise<FailedLogsResult> {
  const failed = await gh(["run", "view", runId, ...repoArgs, "--log-failed"]);
  const logs = clip(failed.stdout.trim());
  if (!failed.ok) {
    return {
      ok: false,
      logs,
      error: clip(failed.stderr.trim() || "Failed to fetch GitHub Actions failed-step logs."),
    };
  }
  return { ok: true, logs };
}

function nextStepHint(run: RunSummary): string {
  if (run.status === "queued" || run.status === "in_progress") {
    return "The run is still executing. Call action=watch again with the same runId. Do not re-run or force-push while it is in progress.";
  }
  if (run.status === "completed" && run.conclusion === "success") {
    return "The run finished successfully. Continue with the next task step.";
  }
  if (run.status === "completed") {
    return `The run finished with conclusion=${run.conclusion ?? "unknown"}. Call action=logs with runId=${run.databaseId}, fix the failures, push, then action=verify the new run.`;
  }
  return `The run returned an unexpected status (${run.status ?? "unknown"}). Treat it as unverified and inspect the run before continuing.`;
}

export default tool({
  description:
    "Bounded GitHub Actions companion for the repository test suite: read the latest CI run status, wait briefly for completion, fetch failed test logs, or verify in one call (wait + auto-fetch failure logs). verify is fail-closed: only completed+success is accepted as green. Every call returns within a fixed time budget and always produces text output. Use this after pushing test or source changes to validate on GitHub instead of running heavy local test toolchains on constrained runtimes.",
  args: {
    action: tool.schema.string().describe("One of: status | watch | logs | verify"),
    branch: tool.schema
      .string()
      .optional()
      .describe("Filter the latest run by branch name (default: any recent)."),
    workflow: tool.schema.string().optional().describe("Workflow name filter (default: 'CI')."),
    repo: tool.schema
      .string()
      .optional()
      .describe("Repository owner/name for gh (default: inferred from the current git checkout)."),
    commit: tool.schema
      .string()
      .optional()
      .describe("Optional commit SHA filter when resolving the latest workflow run."),
    runId: tool.schema
      .string()
      .optional()
      .describe("Explicit Actions run id for watch/logs (default: resolve the latest run)."),
    maxWaitMs: tool.schema
      .number()
      .optional()
      .describe(
        `For watch/verify: total wait budget in ms, default ${DEFAULT_WATCH_BUDGET_MS}, capped at ${MAX_WATCH_BUDGET_MS}.`,
      ),
  },
  async execute(args) {
    const action = String(args.action ?? "").trim().toLowerCase();
    const validActions = ["status", "watch", "logs", "verify"];
    if (!validActions.includes(action)) {
      return result({ ok: false, error: `action must be one of: ${validActions.join(" | ")}` });
    }

    const workflowName = (args.workflow ?? "CI").trim() || "CI";
    const branch = args.branch?.trim() || "";
    const commit = args.commit?.trim() || "";
    const repo = args.repo?.trim() || "";
    const repoArgs = repo ? ["--repo", repo] : [];
    let runId = String(args.runId ?? "").trim();
    let run: RunSummary | null = null;

    if (!runId) {
      const listArgs = [
        "run",
        "list",
        ...repoArgs,
        "--workflow",
        workflowName,
        "--limit",
        "10",
        "--json",
        RUN_JSON_FIELDS,
      ];
      if (branch) listArgs.push("--branch", branch);
      if (commit) listArgs.push("--commit", commit);

      const list = await gh(listArgs);
      if (!list.ok) {
        return result({
          ok: false,
          error: `Could not list workflow runs: ${clip(list.stderr || list.stdout)}`,
          hint: "Check gh authentication, the workflow name, and the requested branch/commit filters.",
        });
      }

      run = parseRuns(list.stdout)[0] ?? null;
      if (!run) {
        return result({
          ok: false,
          error: `No runs found for workflow "${workflowName}"${branch ? ` on branch ${branch}` : ""}${commit ? ` at commit ${commit}` : ""}.`,
          hint: "Push a commit or open a PR to trigger CI, then call again. Never fall back to an unrelated workflow run.",
        });
      }
      if (branch && run.headBranch !== branch) {
        return result({
          ok: false,
          run,
          error: `Resolved run branch ${run.headBranch ?? "unknown"} does not match requested branch ${branch}.`,
        });
      }
      if (commit && !sameCommit(run.headSha, commit)) {
        return result({
          ok: false,
          run,
          error: `Resolved run commit ${run.headSha ?? "unknown"} does not match requested commit ${commit}.`,
        });
      }

      runId = String(run.databaseId ?? "");
      if (!runId) {
        return result({ ok: false, run, error: "Resolved workflow run has no database id." });
      }
    }

    if (action === "logs") {
      const failed = await failedLogs(runId, repoArgs);
      return result({
        ok: failed.ok,
        runId,
        logs: failed.logs,
        ...(failed.error ? { error: failed.error } : {}),
        hint: failed.ok
          ? "Fix every reported failure, push the branch, then action=verify the new run."
          : "Failed-step logs could not be fetched. Inspect the run directly instead of treating this as a successful log lookup.",
      });
    }

    if (action === "status") {
      if (!run) {
        const view = await gh(["run", "view", runId, ...repoArgs, "--json", RUN_JSON_FIELDS]);
        if (!view.ok) {
          return result({
            ok: false,
            error: `Could not read run ${runId}: ${clip(view.stderr || view.stdout)}`,
          });
        }
        run = parseRun(view.stdout);
        if (!run) {
          return result({ ok: false, error: `Could not parse status for run ${runId}.` });
        }
      }
      return result({ ok: true, run, hint: nextStepHint(run) });
    }

    const budget = Math.max(
      10_000,
      Math.min(Math.trunc(args.maxWaitMs ?? DEFAULT_WATCH_BUDGET_MS), MAX_WATCH_BUDGET_MS),
    );
    const startedAt = Date.now();
    const deadline = startedAt + budget;
    let last: RunSummary | null = run;
    let polls = 0;

    for (;;) {
      polls += 1;
      const view = await gh(["run", "view", runId, ...repoArgs, "--json", RUN_JSON_FIELDS]);
      if (!view.ok) {
        return result({
          ok: false,
          run: last,
          error: `Could not watch run ${runId}: ${clip(view.stderr || view.stdout)}`,
          hint: "Verify the runId with action=status.",
        });
      }

      last = parseRun(view.stdout);
      if (!last) {
        return result({
          ok: false,
          error: `Could not parse workflow run ${runId}; refusing to infer a green result.`,
          hint: "Inspect the run directly and retry once gh returns valid JSON.",
        });
      }

      const status = String(last.status ?? "");
      if (status === "completed") {
        const succeeded = last.conclusion === "success";
        if (action === "verify") {
          if (succeeded) {
            return result({
              ok: true,
              run: last,
              waitedMs: Date.now() - startedAt,
              polls,
              logs: "",
              hint: "CI is green: the suite is validated. Continue with the next task step.",
            });
          }

          const failed = await failedLogs(runId, repoArgs);
          return result({
            ok: false,
            run: last,
            waitedMs: Date.now() - startedAt,
            polls,
            logs: failed.logs,
            logFetchOk: failed.ok,
            ...(failed.error ? { logError: failed.error } : {}),
            hint: "Read the failure state/logs, fix every reported failure, push, then call action=verify again on the new run.",
          });
        }

        return result({
          ok: succeeded,
          run: last,
          waitedMs: Date.now() - startedAt,
          polls,
          hint: nextStepHint(last),
        });
      }

      if (status !== "queued" && status !== "in_progress") {
        return result({
          ok: false,
          run: last,
          waitedMs: Date.now() - startedAt,
          polls,
          error: `Unexpected workflow status: ${status || "unknown"}.`,
          hint: "Treat this run as unverified and inspect it before continuing.",
        });
      }

      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        return result({
          ok: action === "watch",
          pending: true,
          run: last,
          waitedMs: Date.now() - startedAt,
          polls,
          hint:
            action === "verify"
              ? `CI is still running after the bounded wait. Verification is not green yet; call action=verify again with runId=${runId}.`
              : `Still running after the bounded wait. Call action=watch again with runId=${runId}.`,
        });
      }
      await sleep(POLL_INTERVAL_MS);
    }
  },
});
