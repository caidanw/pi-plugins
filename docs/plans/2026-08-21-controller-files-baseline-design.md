# Controller Files and Dirty-Tree Baselines

## Goal

Avoid warning users about plan-execution controller files while preserving enough evidence for the auditor to distinguish every pre-existing file from worker changes.

## Behavior

Capture the complete Git status and diff without filtering and store them in the task-graph baseline. Use `--untracked-files=all` so Git records individual untracked files instead of collapsing an entire directory such as `?? docs/`.

Before showing the dirty-worktree confirmation, obtain a separate status that excludes only these exact controller-owned paths:

- Source plan.
- Generated task graph.
- Generated audit report.

Continue showing unrelated changes, including other files in the same directory.

At approval, refresh the full baseline after planning so the saved draft task graph and all other current files are known to predate workers. Tell the final auditor explicitly that the source plan, task graph, and audit report are controller-owned and must not be attributed to workers.

## Safety

Filtering affects only the confirmation display. It never removes files from baseline or final-state evidence. Use exact repository-relative Git pathspec exclusions; do not exclude whole directories.

## Testing

Verify that Git expands untracked directories, the confirmation hides exact controller files but retains unrelated siblings, the full baseline retains all files, and the audit prompt identifies controller-owned paths.
