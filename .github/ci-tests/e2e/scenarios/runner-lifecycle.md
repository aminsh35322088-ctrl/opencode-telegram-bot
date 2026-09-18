# Runner lifecycle preflight — physical bot testing

Run this scenario **only when the physical Telegram test is hosted on GitHub-Runner-Lab**. It validates the live runner safety/recovery plumbing without changing the real lifecycle deadline or the real handoff checkpoint state.

## Preconditions

- RDC is connected.
- You can access the `GitHub-Runner-Lab` checkout.
- Do not edit `runtime.env`, `ONLINE_MINUTES`, or the live workflow deadline for this scenario.
- The checkpoint smoke must use an isolated temporary checkpoint directory. Never point the test at the live `~/agent-checkpoints` directory.

## Checks

1. **Live status is visible**
   - Run `./scripts/agent-run.sh status` from the Lab repository.
   - Confirm the output contains:
     - `AGENT_PREWARM`
     - `RUNTIME_STATE`
     - `REMAINING_MINUTES`
     - `HANDOFF_UTC`
   - Expected: no parse error, missing timer, or stale/unknown runtime while the active Lab run is healthy.

2. **Work-mode gate is obeyed**
   - If state is `SAFE`, continue the physical bot test.
   - If state is `CAUTION`, restrict the session to bounded smoke checks.
   - If state is `CHECKPOINT_REQUIRED`, `HANDOFF_IMMINENT`, or `HANDOFF_DUE`, stop before starting a new bot scenario and move work to a successor runner.

3. **Isolated non-destructive checkpoint smoke**
   - Create a disposable Git repo under `~/agent-workspaces/_runner-lifecycle-smoke`.
   - Create a separate temporary checkpoint root, for example:
     ```bash
     CHECKPOINT_SMOKE_DIR="$(mktemp -d)"
     export AGENT_CHECKPOINT_DIR="$CHECKPOINT_SMOKE_DIR"
     ```
   - Commit one small tracked file, modify that tracked file, and create one untracked file containing a recognizable dummy string.
   - Run:
     ```bash
     ./scripts/agent-run.sh checkpoint physical-test-smoke
     ```
   - Verify `$AGENT_CHECKPOINT_DIR/latest` contains the tracked diff and lists the untracked filename.
   - Verify the dummy **contents** of the untracked file were not copied into the checkpoint.
   - Delete the disposable repo and temporary checkpoint directory after verification.
   - Confirm the live `~/agent-checkpoints` directory and its `latest` symlink were not changed by the smoke test.

4. **GitHub-side visibility**
   - If GitHub access is available, open/read the current `GitHub-Runner-Lab` README or workflow run.
   - Confirm it exposes the current runner state/time window and a link to the active run.
   - A README snapshot may lag by roughly one watchdog interval; the local `agent-run.sh status` result is the exact connected-run clock.

5. **Connection survives the preflight**
   - Check RDC health again after the checkpoint smoke.
   - Expected: `remote_status=ready` and the same active RDC process/session remains available.

## Pass criteria

- Live timer/status is readable.
- The current work mode is respected.
- Checkpoint generation works in an isolated test directory.
- Tracked changes are recoverable.
- Untracked file contents are not copied.
- The live checkpoint state is untouched.
- No live timer/deadline is modified.
- RDC remains connected throughout the check.

## Failure handling

If any checkpoint/status command fails, do not continue a long physical bot test. Preserve/push current work first, capture the Lab status/logs, and repair the runner safety path before relying on that runner for extended manual testing.
