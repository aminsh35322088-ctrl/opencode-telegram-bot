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
  displayTitle?: string;
  url?: string;
  event?: string;
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
    const e = error as { stdout?: string; stderr?: string; killed?: boolean; signal?: string; message?: string };
    const timedOut = Boolean(e.killed) || e.signal === "SIGTERM";
    const stderr = timedOut
      ? `gh ${args.join(" ")} timed out after ${timeoutMs}ms`
      : (e.stderr || e.message || String(error)).trim();
    return { ok: false, stdout: e.stdout ?? "", stderr, timedOut };
  }
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT ? `…(truncated, ${text.length} chars total)\n${text.slice(-MAX_OUTPUT)}` : text;
}

function parseRuns(stdout: string): RunSummary[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? (parsed as RunSummary[]) : [];
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function result(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, null, 2);
}

function nextStepHint(run: RunSummary): string {
  if (run.status === "queued" || run.status === "in_progress") {
    return "The run is still executing. Call action=watch again with the same runId. Do not re-run or force-push while it is in progress.";
  }
  if (run.conclusion && run.conclusion !== "success") {
    return `The run finished with conclusion=${run.conclusion}. Call action=logs with runId=${run.databaseId}, fix the failures, push, then action=watch the new run.`;
  }
  return "The run finished successfully. Continue with the next task step.";
}

export default tool({
  description:
    "Bounded GitHub Actions companion for the repository test suite: read the latest CI run status, wait briefly for completion, and fetch failed test logs via the gh CLI. Every call returns within a fixed time budget and always produces text output: if the run is still going, it reports progress and you must call again. Use this after pushing test or source changes to validate on GitHub instead of running heavy local test toolchains on constrained runtimes.",
  args: {
    action: tool.schema.string().describe("One of: status | watch | logs"),
    branch: tool.schema.string().optional().describe("Filter the latest run by branch name (default: any recent)."),
    workflow: tool.schema.string().optional().describe("Workflow name filter (default: 'CI')."),
    runId: tool.schema.string().optional().describe("Explicit Actions run id for watch/logs (default: resolve the latest run)."),
    maxWaitMs: tool.schema.number().optional().describe(`For watch: total wait budget in ms, default ${DEFAULT_WATCH_BUDGET_MS}, capped at ${MAX_WATCH_BUDGET_MS}.`),
  },
  async execute(args) {
    const action = String(args.action ?? "").trim().toLowerCase();
    if (action !== "status" && action !== "watch" && action !== "logs") {
      return result({ ok: false, error: "action must be one of: status | watch | logs" });
    }

    const workflowName = (args.workflow ?? "CI").trim() || "CI";
    let runId = String(args.runId ?? "").trim();
    let run: RunSummary | null = null;

    if (!runId) {
      const listArgs = ["run", "list", "--limit", "10", "--json", "databaseId,name,status,conclusion,headBranch,displayTitle,url,event"];
      if (args.branch) listArgs.push("--branch", args.branch.trim());
      const list = await gh(listArgs);
      if (!list.ok && !list.stdout) {
        return result({ ok: false, error: `Could not list workflow runs: ${clip(list.stderr)}`, hint: "Check that the gh CLI is authenticated (GH_TOKEN) and the repository has Actions runs." });
      }
      run = parseRuns(list.stdout).find((entry) => entry.name === workflowName) ?? parseRuns(list.stdout)[0] ?? null;
      if (!run) {
        return result({ ok: false, error: `No workflow runs found for workflow "${workflowName}"${args.branch ? ` on branch ${args.branch}` : ""}.`, hint: "Push a commit or open a PR to trigger CI, then call again." });
      }
      runId = String(run.databaseId ?? "");
    }

    if (action === "logs") {
      const failed = await gh(["run", "view", runId, "--log-failed"]);
      const logText = failed.stdout.trim();
      if (!failed.ok && !logText) {
        return result({ ok: true, runId, logs: "", note: clip(failed.stderr), hint: "No failed-job logs yet (the run may still be in progress or everything passed). Call action=status to check." });
      }
      return result({ ok: true, runId, logs: clip(logText), hint: "Fix every reported failure, push the branch, then action=watch the new run." });
    }

    if (action === "status") {
      if (run) {
        return result({ ok: true, run, hint: nextStepHint(run) });
      }
      const view = await gh(["run", "view", runId, "--json", "databaseId,name,status,conclusion,headBranch,displayTitle,url,event"]);
      if (!view.ok && !view.stdout) {
        return result({ ok: false, error: `Could not read run ${runId}: ${clip(view.stderr)}` });
      }
      const parsed = (() => { try { return JSON.parse(view.stdout) as RunSummary; } catch { return null; } })();
      return result({ ok: true, run: parsed, hint: parsed ? nextStepHint(parsed) : "Could not parse the run status; call action=logs." });
    }

    const budget = Math.max(10_000, Math.min(Math.trunc(args.maxWaitMs ?? DEFAULT_WATCH_BUDGET_MS), MAX_WATCH_BUDGET_MS));
    const deadline = Date.now() + budget;
    let last: RunSummary | null = run;
    let polls = 0;

    for (;;) {
      polls += 1;
      const view = await gh(["run", "view", runId, "--json", "databaseId,name,status,conclusion,headBranch,displayTitle,url,event"]);
      if (view.stdout.trim()) {
        try {
          last = JSON.parse(view.stdout) as RunSummary;
        } catch {
          /* keep the previous snapshot */
        }
      }
      if (!view.ok && !view.stdout.trim() && polls === 1) {
        return result({ ok: false, error: `Could not watch run ${runId}: ${clip(view.stderr)}`, hint: "Verify the runId with action=status." });
      }
      const status = String(last?.status ?? "");
      if (status !== "queued" && status !== "in_progress") {
        return result({ ok: true, run: last, waitedMs: Date.now() - (deadline - budget), polls, hint: last?.conclusion && last.conclusion !== "success" ? `Call action=logs with runId=${runId}.` : "Suite is green; continue the task." });
      }
      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        return result({ ok: true, run: last, waitedMs: budget, polls, hint: `Still running after ${budget}ms of waiting. Call action=watch again with runId=${runId} — do not assume failure or silence.` });
      }
      await sleep(POLL_INTERVAL_MS);
    }
  },
});
