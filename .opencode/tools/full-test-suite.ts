import { spawn } from "node:child_process";
import { tool } from "@opencode-ai/plugin";

const repository = process.env.GITHUB_REPOSITORY ?? "aminsh35322088-ctrl/opencode-telegram-bot";
const workflow = "ci.yml";
const ref = process.env.GITHUB_REF_NAME ?? "main";
const timeoutMs = 30_000;
const watchTimeoutMs = 20 * 60_000;
const maxOutputBytes = 128 * 1024;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function run(command: string, args: string[], timeout: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const append = (current: string, chunk: Buffer | string) => {
      const value = current + chunk.toString();
      return value.length > maxOutputBytes ? value.slice(-maxOutputBytes) : value;
    };

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() });
    };

    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      stderr = append(stderr, String(error));
      finish(1);
    });
    child.once("close", (code, signal) => {
      finish(code ?? (signal ? 1 : 0));
    });

    const timer = setTimeout(() => {
      stderr = append(stderr, `Command timed out after ${timeout}ms.`);
      try {
        child.kill("SIGTERM");
      } catch {
        // The child may already have exited.
      }
      finish(124);
    }, timeout);
  });
}

export default tool({
  description:
    "Run the complete repository validation suite directly in GitHub Actions. Never installs or executes test dependencies inside Railway.",
  args: {},
  async execute() {
    const dispatch = await run(
      "gh",
      ["workflow", "run", workflow, "--repo", repository, "--ref", ref],
      timeoutMs,
    );

    if (dispatch.exitCode !== 0) {
      return JSON.stringify(
        {
          ok: false,
          stage: "dispatch",
          repository,
          workflow,
          ref,
          error: dispatch.stderr || dispatch.stdout || "Failed to dispatch GitHub Actions.",
        },
        null,
        2,
      );
    }

    const waitForRun = await run(
      "gh",
      [
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        workflow,
        "--branch",
        ref,
        "--limit",
        "1",
        "--json",
        "databaseId,status,conclusion,headSha,url",
      ],
      timeoutMs,
    );

    if (waitForRun.exitCode !== 0 || !waitForRun.stdout) {
      return JSON.stringify(
        {
          ok: false,
          stage: "locate-run",
          repository,
          workflow,
          ref,
          error: waitForRun.stderr || "Workflow dispatched but run could not be located.",
        },
        null,
        2,
      );
    }

    let runInfo: { databaseId?: number; status?: string; conclusion?: string | null; headSha?: string; url?: string };
    try {
      runInfo = JSON.parse(waitForRun.stdout)[0] ?? {};
    } catch {
      return JSON.stringify(
        { ok: false, stage: "parse-run", error: "GitHub CLI returned invalid run metadata.", output: waitForRun.stdout },
        null,
        2,
      );
    }

    const runId = runInfo.databaseId;
    if (!runId) {
      return JSON.stringify(
        { ok: false, stage: "locate-run", repository, workflow, ref, error: "No workflow run ID was returned." },
        null,
        2,
      );
    }

    const watched = await run(
      "gh",
      ["run", "watch", String(runId), "--repo", repository, "--exit-status"],
      watchTimeoutMs,
    );

    const details = await run(
      "gh",
      ["run", "view", String(runId), "--repo", repository, "--json", "databaseId,status,conclusion,headSha,url,jobs"],
      timeoutMs,
    );

    let finalRun: unknown = details.stdout;
    try {
      finalRun = JSON.parse(details.stdout);
    } catch {
      // Preserve raw CLI output.
    }

    return JSON.stringify(
      {
        ok: watched.exitCode === 0,
        stage: "complete",
        repository,
        workflow,
        ref,
        runId,
        run: finalRun,
        watchOutput: watched.stdout,
        watchError: watched.stderr,
      },
      null,
      2,
    );
  },
});
