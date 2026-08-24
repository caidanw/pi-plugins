# Verified Task Commits

## Goal

Create one controller-owned Git commit after each task passes mechanical verification without allowing workers to commit unverified or unrelated changes.

## Enablement and Preflight

New planner graphs enable per-task commits. Existing graphs that lack the setting remain in legacy uncommitted mode; regenerate them to opt in.

Before approving a commit-enabled graph, require:

- A Git repository with an existing `HEAD`.
- A named current branch.
- Configured Git author name and email.
- No implementation changes outside the source plan, task graph, and audit paths.

Do not stash, reset, or commit pre-existing changes automatically. If preflight fails, preserve the draft and explain how to commit or stash unrelated changes.

Record the starting `HEAD` in the graph baseline.

## Task Lifecycle

Workers continue to receive an explicit instruction not to mutate Git. The worker guard blocks direct mutating Git shell commands, and the controller compares Git branch and `HEAD` before and after every worker as the authoritative backstop. A changed Git position fails the run for manual recovery. After controller verification succeeds:

1. Persist the task as `verified` with its passing evidence.
2. Stage all repository changes except controller-owned files.
3. Commit with `plan(<task-id>): <task title>`.
4. Record the commit hash as controller evidence.
5. Mark the task `passed` and dispatch the next dependency-ready task.

Allow empty commits so every verified task has a durable task boundary.

If staging or committing fails, leave the task `verified`, preserve staged and working-tree changes, pause the graph, and report the error. Resuming retries the commit before launching any worker, so commit failures never consume a model attempt. Record the pre-task `HEAD`; if a commit completed before graph persistence, resume recognizes its task-specific subject and records it instead of creating a duplicate commit.

## Recovery

A paused graph may contain a `verified` task. `/execute-plan` and `/plan-resume` retry that commit first. Partial changes from an interrupted implementation remain associated with its already-counted attempt and are committed only after verification passes.

## Audit

The final auditor receives:

- Full pre-worker baseline status and diff.
- Starting Git `HEAD`.
- Commit log and diff from starting `HEAD` to final `HEAD`.
- Final working-tree status and diff.
- Controller-owned path declarations.

This keeps committed implementation work visible to the independent audit.

## Testing

Cover clean-tree preflight, legacy graphs, successful and empty commits, controller-file exclusions, commit failure and resume, attempt preservation, commit evidence, and committed-range audit input.
