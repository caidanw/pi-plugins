# Plan Execution Plugin

## Goal

Add one Pi command that turns an approved Markdown plan into a reviewed task graph, executes every task with a fresh worker, verifies each task mechanically, and audits the final implementation.

The plugin must prevent workers from skipping tasks, changing the plan, or declaring success without a passing verification command.

## User Flow

Start the workflow with one command:

```text
/execute-plan docs/plans/feature.md
```

The plugin then:

1. Converts the Markdown plan into a strict task DAG.
2. Shows the generated tasks for review.
3. Offers **Approve and run**, **Add feedback**, or **Cancel**.
4. Regenerates the DAG after feedback until approved.
5. Executes dependency-ready tasks automatically.
6. Runs each task's verification command.
7. Runs a fresh read-only audit after every task passes.

Keep three auxiliary commands:

```text
/plan-resume
/plan-status
/plan-stop
```

`/plan-resume` recursively discovers unfinished task graphs in the current repository and delegates the selected graph to the same review, resume, or regeneration flow as `/execute-plan`.

Calling `/execute-plan` again for an unfinished plan offers to resume or regenerate it. Regeneration discards prior task state and evidence only after confirmation, then requires a new approval before any verification command can run.

## Architecture

```text
Markdown plan
    ↓
fresh read-only planner process
    ↓
validated task DAG
    ↓
human review and feedback loop
    ↓
focused controller dashboard
    ↓
fresh implementation process for one ready task
    ↓
controller-owned verification
    ↓
controller-owned task commit
    ↓
next task
    ↓
fresh read-only final auditor
```

The original Markdown file remains the source of intent. A sibling `<name>.tasks.json` file stores the executable graph and runtime state. A sibling `<name>.audit.md` file stores the final audit.

## Why Workers Are Pi Subprocesses

`pi-subagents` exposes a structured delegation API for extensions, but depending on it is unnecessary for v1. Pi's example subagent extension also demonstrates the underlying mechanism: fresh `pi --mode json -p --no-session` processes.

Use `node:child_process.spawn` to run Pi directly because it provides:

- A fresh context for every task.
- Explicit model, tools, working directory, environment, and cancellation control.
- Structured JSON event output for progress, final-tool capture, and failure detection.
- A live child handle for `/plan-stop` and `session_shutdown`.
- No dependency on another extension or bridge package.

A worker subprocess is therefore the implementation mechanism for a small subagent. A future version may delegate process management to `pi-subagents` if its richer orchestration becomes useful.

## Planning and Approval

The planning process uses the session's active model and receives:

- The original Markdown plan.
- Only non-mutating repository tools such as `read`, `grep`, `find`, and `ls`.
- The current task graph when revising.
- The user's feedback when revising.

It submits the completed task list through a dedicated terminating `submit_task_graph` tool. The tool schema excludes runtime state and encodes required task fields. The controller captures the successful tool result as it streams, adds initial runtime state, validates the DAG, and atomically saves it as a draft before showing it. Every valid feedback revision replaces the saved draft; planner failures and review cancellation preserve the last valid version. Planner prose is never parsed as executable state.

The review shows each task's:

- ID and description.
- Dependencies.
- Acceptance criteria.
- Expected files.
- Verification command.

Selecting **Add feedback** opens a text editor. Feedback may reference task IDs, add missing work, change dependencies, or request task splits and merges. The plugin launches a fresh planner with the original plan, current DAG, and feedback, then repeats the review.

Approval persists the DAG and starts execution automatically. Approval is the trust boundary for model-generated verification commands, which run through the user's shell with the user's permissions. New graphs require a clean implementation tree and create one controller-owned Git commit after each verified task; controller files are excluded. Every regenerated DAG requires fresh approval.

## Focused Workflow UI

In TUI mode, replace the editor with a focused dashboard while planning, executing, verifying, repairing, or auditing. This prevents concurrent edits in the shared checkout. Keep the existing task-review selector and feedback editor between dashboard phases.

The dashboard shows:

- The current workflow phase and elapsed time.
- Passed, active, and pending tasks.
- The current attempt out of two.
- The verification command and recent output.
- Friendly activity lines derived from child Pi tool events.

Parse JSON events as each subprocess writes them. Convert recognized tool starts into concise activities such as `Reading package.json`, `Searching for requestParser`, and `Editing src/request.ts`. Ignore unknown events and raw model text. Keep at most 200 activities in memory and display the newest 8–24 based on terminal height. Show how many earlier activities are hidden. Throttle rendering to avoid flicker.

The first `Esc` displays `Press Esc again within 2 seconds to pause and exit`. A second `Esc` within that window confirms. The action depends on the phase:

- Planning: abort and discard the unapproved graph.
- Review: cancel without executing.
- Execution or verification: terminate the process group, preserve partial working-tree changes, count the attempt, mark the task pending, and persist the graph as paused.
- Audit: stop the advisory audit while preserving the completed run.

Close the dashboard after cancellation, failure, or completion and add a durable `[plan]` summary to chat. Keep the existing durable-message behavior for RPC and other non-TUI clients. The task graph remains the source of truth; dashboard failures must not change controller results.

## Task Graph

```json
{
  "version": 1,
  "sourcePlan": "docs/plans/feature.md",
  "status": "approved",
  "commitAfterTask": true,
  "baseline": {
    "gitStatus": "",
    "gitDiff": "",
    "gitHead": "abc123"
  },
  "tasks": [
    {
      "id": "T001",
      "title": "Add the request parser",
      "instructions": "Implement the parser described in the source plan.",
      "acceptance": [
        "Valid requests produce a parsed request",
        "Invalid requests return the documented error"
      ],
      "dependsOn": [],
      "expectedFiles": ["src/request.ts", "test/request.test.ts"],
      "verification": "npm test -- test/request.test.ts",
      "status": "pending",
      "attempts": 0
    }
  ]
}
```

Required validation:

- Version is supported.
- Task IDs are unique.
- Every dependency exists.
- The graph has no cycles.
- Every task has acceptance criteria and a verification command.
- Every status is recognized.
- Commit-enabled graphs have baseline Git state before execution.
- At least one task exists.

Allow these run statuses: `draft`, `approved`, `running`, `paused`, `completed`, and `failed`.

```text
draft → approved → running → completed
                         ↘ failed
                         ↘ paused → running
```

Use these task states:

```text
pending → running → verified → passed
                  ↘ failed
```

For commit-enabled graphs, `verified` persists successful verification before the controller stages and commits task changes. Commit failure pauses the graph at `verified` without consuming another worker attempt. Existing graphs without commit enablement retain the legacy direct `running → passed` transition.

Store the complete dirty-worktree baseline at the graph's top level, expanding untracked directories into individual files. The approval warning may hide the exact source plan, task graph, and audit paths, but they remain in baseline evidence and are identified to the auditor as controller-owned files. Store each verification command, exit code, and bounded output as task completion evidence.

## Execution

In TUI mode, the controller runs behind the focused dashboard and blocks normal editor input. RPC and other non-TUI clients retain background execution and durable status messages. V1 does not lock the worktree, so external editors and processes can still create conflicts.

For each task:

1. Select the first dependency-ready pending task in array order.
2. Increment `attempts`, mark it running, and persist the graph.
3. Snapshot and hash the protected files.
4. Spawn a fresh Pi worker with `node:child_process.spawn` in the project directory, using the session's active model.
5. Give it a bounded task packet.
6. Wait for the worker to exit, terminate ordinary remaining process-group descendants, and avoid writing `tasks.json` while the child is alive.
7. Verify protected-file integrity before and after verification.
8. Run the verification command through the controller with a 10-minute timeout.
9. Persist successful verification as `verified`.
10. Stage all non-controller changes and create `plan(<task-id>): <title>`.
11. Mark the task passed only after the commit succeeds.
12. Continue with the next ready task.

The task packet contains:

```text
Source plan path
Current task ID, instructions, and acceptance criteria
Completed dependency summaries and verification evidence
Expected files
Verification command
```

Workers may read the source plan and repository for context. They must not implement unrelated future tasks or stage, commit, reset, restore, or check out Git changes. The controller owns verification and commits.

A worker subprocess or provider failure records infrastructure evidence, preserves partial changes, pauses the graph, and does not consume an implementation attempt. Protected-file violations, verification timeouts, and nonzero verification exits consume the attempt. Launch one fresh repair worker with the original task and failure output only when `attempts < 2`. Persist attempts across intentional pauses and resumes; a pending task already at two implementation attempts fails without launching a third worker. After two unsuccessful implementation attempts, mark the task failed and stop the run.

## Parallelism

The planner records the full dependency DAG and identifies independent work through dependency edges and expected files.

V1 still executes one task at a time in one checkout. Parallel writers require isolated worktrees, merge ordering, and conflict recovery. Add parallel execution only when sequential execution is measurably too slow.

## Protected Plan State

Protect both the source Markdown plan and generated task graph.

For each worker:

1. Resolve protected paths to canonical absolute paths and pass them through an environment variable.
2. Load a worker-mode extension hook that canonicalizes target paths and blocks `edit` and `write` calls targeting protected files.
3. Snapshot both files, including content hashes, modes, inode identity, and link counts, before the worker starts.
4. Do not let the controller write `tasks.json` while the worker is alive.
5. After the worker exits and after verification, detect content, mode, identity, deletion, rename, symlink, or hard-link changes.
6. Unlink any changed path, recreate it from the controller snapshot, and reject the attempt if integrity changed through `bash`, a path alias, or another route.

The post-exit integrity check and restoration are authoritative; the tool hook provides early feedback. The worker hook also blocks direct mutating Git commands, while pre/post-worker branch and `HEAD` comparison catches indirect Git mutations and stops for manual recovery. Process-group cleanup stops ordinary background descendants. A process that deliberately creates a new OS session can escape this v1 control; preventing that requires an OS sandbox. A rejected attempt consumes one of the task's two attempts. Workers retain read access. Only the controller changes task status or evidence.

## Final Audit

After every task passes, launch a fresh read-only Pi process. Give it:

- The original Markdown plan.
- The completed task graph and evidence.
- Baseline and final Git status/diff information.
- The task commit log and committed diff from baseline `HEAD` through final `HEAD`.
- Read-only repository tools.

Ask it to report:

- Original plan requirements omitted from the DAG.
- Tasks incompletely represented in the implementation.
- Missing wiring or dead implementations.
- Unplanned scope changes.
- Claims unsupported by verification evidence.

Write the result to `<name>.audit.md` and notify the user. V1 does not block completion or automatically fix audit findings.

## Recovery and Cancellation

- `/plan-status` reads in-memory state while a worker is alive and reports the active plan, current task, passed count, failed task, and worker state without writing `tasks.json`.
- Confirmed `Esc` in the TUI and `/plan-stop` in other clients abort the current subprocess, wait for it to exit, restore the current task to `pending`, then persist the run as `paused` without discarding completed evidence or decrementing attempts.
- `session_shutdown` follows the same abort-and-persist sequence when shutdown hooks run.
- On load, normalize any stale `running` task to `pending` while preserving its attempt count. This recovers from a hard process crash that skipped shutdown hooks.
- `/execute-plan <same-plan>` detects unfinished state and offers **Resume**, **Regenerate**, or **Cancel**.
- **Regenerate** confirms that all task state and evidence will be discarded, then starts a fresh planning and approval flow.
- Reject a second run while another controller is active.

Commit-enabled graphs require a named branch, configured Git identity, an existing `HEAD`, no staged changes, and a clean implementation tree outside controller-owned paths. Preserve a failing draft and tell the user to commit or stash unrelated changes. Existing legacy graphs may retain the prior dirty-worktree confirmation. Record baseline `HEAD`, status, and staged/unstaged diffs for the final auditor.

## Error Handling

- Invalid planner JSON: show the validation error and offer another feedback/revision pass.
- Missing or unauthenticated model: stop before writing executable state.
- Planner crash: retain the last valid task graph.
- User or shutdown cancellation: restore the current task to pending, preserve its attempt count, and pause the run; never mark it passed.
- Worker subprocess or provider failure: record bounded infrastructure evidence, preserve partial changes, refund the reserved attempt, and pause for explicit resume.
- Protected-file violation, verification timeout, or nonzero verification exit: record bounded failure evidence and apply the two-attempt rule.
- No dependency-ready task while pending tasks remain: report an invalid or blocked graph and stop.
- Audit failure: preserve the completed run and report that the audit could not be generated.

## Tests

Use Node's built-in test runner.

Test observable behavior:

1. Reject malformed or cyclic task graphs.
2. Dispatch only tasks whose dependencies passed.
3. Advance only after a verification command exits successfully.
4. Retry once after failed verification, then stop.
5. Restore protected files and reject content, mode, identity, deletion, rename, symlink, or hard-link changes.
6. Normalize a stale running task to pending while preserving its attempt count, and never launch a third attempt.
7. Stop before spawning when cancellation arrives during setup.
8. Terminate ordinary background process-group descendants before integrity checks.
9. Preserve completed state across reload/resume.
10. Write a successful audit and keep a completed run successful when the optional audit process fails.
11. Parse streamed JSON across chunk boundaries, retain final results when buffered output truncates, and convert known tool events into bounded activity text.
12. Require two `Esc` presses within two seconds before cancellation.
13. Keep controller results unchanged when dashboard rendering fails.
14. Preserve the existing durable-message flow outside TUI mode.

Use a fake Pi executable for subprocess tests. Test the progress state and input handling without snapshotting terminal decoration. Do not call real models in the test suite.

## V1 Scope

Include:

- Markdown-to-DAG planning.
- Human approval and feedback loop.
- Sequential fresh workers.
- Controller-owned verification.
- One repair attempt.
- Protected plan state.
- Persistent status and resume.
- Read-only final audit.
- Focused TUI progress dashboard.

Exclude:

- Parallel workers.
- Git worktree creation or merges.
- OS-level worker sandboxing.
- Multiple concurrent plans.
- Configurable retry policies.
- Custom model routing.
- Automatic fixes from audit findings.
- External issue trackers or databases.

## Implementation Order

1. Add task graph types, parsing, validation, persistence, and unit tests.
2. Add the Pi subprocess runner and protected-file checks.
3. Add `/execute-plan` planning with a terminating structured-output tool, review, feedback, and approval.
4. Add the sequential controller, verification, repair, status, stop, and resume.
5. Add the final read-only audit and README documentation.
6. Stream subprocess progress into a focused TUI dashboard with confirmed cancellation.
7. Run the full test suite and manually exercise one two-task plan.
