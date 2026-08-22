# Durable Task Drafts

## Goal

Persist every validated planner result before presenting it for review so generated tasks survive cancellation, crashes, and feedback testing.

## State and Persistence

Add `draft` to the task-graph run statuses. `parsePlannerTaskGraph` creates a draft with pending tasks and no evidence. After every successful planner submission, atomically write the graph to the existing `<plan>.tasks.json` path before opening the review UI.

Feedback revisions replace the same file only after the new graph passes validation. A planner failure therefore leaves the last valid draft intact. Canceling review also leaves that draft on disk.

Approval changes the in-memory graph from `draft` to `approved`. The controller records the worktree baseline and persists the approved graph before execution. Draft graphs must never enter `startExecution`.

## Recovery

When `/execute-plan` finds a draft for the same source plan, offer:

- **Review draft**: reopen review without rerunning the planner.
- **Regenerate**: run the planner and replace the draft only after successful validation.
- **Cancel**: leave the draft unchanged.

Existing recovery behavior remains unchanged for approved, running, paused, failed, and completed graphs.

## Testing

Verify that a draft exists before review opens, feedback replaces it, cancel preserves it, reopening can review it without a planner call, and execution rejects a draft.
