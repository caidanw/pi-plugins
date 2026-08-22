# Plan Resume Command

## Goal

Add `/plan-resume` as a repository-local picker for unfinished plan-execution workflows.

## Discovery

Recursively scan the current repository for files ending in `.tasks.json`. Do not follow symbolic-link directories. Skip `.git`, `node_modules`, `.build`, `build`, `dist`, and `coverage` directories.

Load and validate each task graph. Hide completed graphs. Keep invalid graphs and graphs whose source plan is missing in the list, but mark them unavailable. Sort entries by task-graph modification time, newest first.

## Presentation

Each valid entry shows:

- Run status.
- Passed tasks out of total tasks.
- Repository-relative source-plan path.
- Running or next-ready task when available.

Include draft, approved, running, paused, and failed graphs. Failed entries remain available because the existing flow offers regeneration.

## Selection

Selecting a valid graph delegates to the same controller path as `/execute-plan <source-plan>`. This preserves source matching, draft review, regeneration confirmation, attempt limits, authentication checks, and execution behavior in one implementation.

Selecting an unavailable graph reports its validation or missing-source error and does not modify files. Canceling the picker has no side effects. If no task graphs exist, add durable feedback to chat.

## Testing

Cover recursive discovery and exclusions, sorting and labels, hidden completed graphs, unavailable entries, empty repositories, and delegation through the existing resume flow.
