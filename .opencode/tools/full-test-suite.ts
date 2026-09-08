import { spawn } from "node:child_process";
import { tool } from "@opencode-ai/plugin";

const repository = process.env.GITHUB_REPOSITORY ?? "aminsh35322088-ctrl/opencode-telegram-bot";
const defaultRef = process.env.GITHUB_REF_NAME ?? "main";
const workflow = "full-test-suite.yml";
const triggerTimeoutMs = 30_000;
const watchTimeoutMs = 20 * 60_000;
const maxOutputBytes = 128 * 1024;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

function appendOutput(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length > maxOutputBytes ? next.slice(-maxOutputBytes) : next;
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - startedAt,
      });
    };

    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (error) {
      finish(1);
      stderr = String(error);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => {
      if (!stderr) stderr = String(error);
      finish(1);
    });
    child.once("close", (code, signal) => {
      finish(code ?? (signal ? 1 : 0));
    });

    timeoutHandle = setTimeout(() => {
      stderr = `${stderr}\nCommand timed out after ${timeoutMs}ms.`.trim();
      try {
        child.kill("SIGTERM");
      } catch {
        // Child may already have exited.
      }
      finish(124);
    }, timeoutMs);
  });
}

async function getLatestDispatchedRunId(): Promise<number | null> {
  const result = await runCommand(
    "gh",
    [
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      workflow,
      "--event",
      "workflow_dispatch",
      "--limit",
      "10",
      "--json",
      "databaseId,headBranch,status,createdAt",
      "--jq",
      `[.[] | select(.headBranch == "${defaultRef}")] | sort_by(.createdAt) | reverse | .[0].databaseId // empty`,
    ],
    triggerTimeoutMs,
  );

  if (result.exitCode !== 0 || !result.stdout) {
    return null;
  }

  const runId = Number(result.stdout.trim());
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}

export default tool({
  description:
    "Run the complete repository validation suite in GitHub Actions. Tests and their dependencies never run inside the Railway production container. The command is bounded and returns the GitHub Actions result.",
  args: {},
  async execute() {
    const trigger = await runCommand(
      "gh",
      [
        "workflow",
        "run",
        workflow,
        "--repo",
        repository,
        "--ref",
        defaultRef,
        "-f",
        `ref=${defaultRef}`,
      ],
      triggerTimeoutMs,
    );

    if (trigger.exitCode !== 0) {
      return JSON.stringify(
        {
          ok: false,
          stage: "trigger",
          repository,
          workflow,
          ref: defaultRef,
          error: trigger.stderr || trigger.stdout || "Failed to trigger GitHub Actions workflow.",
          durationMs: trigger.durationMs,
        },
        null,
        2,
      );
    }

    // GitHub creates the workflow run asynchronously. Poll briefly until the
    // dispatch appears, rather than assuming the newest run immediately.
    let runId: number | null = null;
    const lookupDeadline = Date.now() + triggerTimeoutMs;
    while (!runId && Date.now() < lookupDeadline) {
      runId = await getLatestDispatchedRunId();
      if (!runId) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    if (!runId) {
      return JSON.stringify(
        {
          ok: false,
          stage: "locate-run",
          repository,
          workflow,
          ref: defaultRef,
          error: "Workflow was dispatched but its run could not be located within the trigger window.",
          triggerOutput: trigger.stdout,
        },
        null,
        2,
      );
    }

    const watch = await runCommand(
      "gh",
      ["run", "watch", String(runId), "--repo", repository, "--exit-status"],
      watchTimeoutMs,
    );

    const details = await runCommand(
      "gh",
      [
        "run",
        "view",
        String(runId),
        "--repo",
        repository,
        "--json",
        "databaseId,status,conclusion,headBranch,headSha,url,jobs",
      ],
      triggerTimeoutMs,
    );

    let runDetails: unknown = details.stdout;
    try {
      runDetails = JSON.parse(details.stdout);
    } catch {
      // Preserve raw output when GitHub CLI did not return JSON.
    }

    return JSON.stringify(
      {
        ok: watch.exitCode === 0,
        stage: "complete",
        repository,
        workflow,
        ref: defaultRef,
        runId,
        run: runDetails,
        watchOutput: watch.stdout,
        watchError: watch.stderr,
        durationMs: watch.durationMs,
      },
      null,
      2,
    );
  },
});
