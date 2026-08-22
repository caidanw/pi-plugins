# Task Review UI

## Goal

Replace the built-in task-graph selection prompt with a focused, scannable review screen before plan execution.

## Layout

Show a compact task list followed by details for the selected task. The task list displays each task's ID, title, and dependency relationship. The detail area separates dependencies, acceptance criteria, expected files, and the verification command with semantic theme colors and headings.

Keep the selected task visible as the user navigates. Bound the task list to the terminal height and wrap detail text to the available display width. Every rendered line must remain within the width supplied by Pi.

## Interaction

- `↑` and `↓`: select a task.
- `A`: approve the complete graph and begin execution.
- `F`: open feedback for the selected task.
- `G`: open general graph feedback.
- `Esc`, then `Esc` again within two seconds: cancel review.

The footer always shows these controls. The first cancellation keypress changes the footer to the confirmation warning.

Task-specific feedback identifies the selected task in both the editor title and planner prompt. The planner should preserve unrelated tasks and stable IDs, while allowing changes required by dependencies. General feedback retains the existing whole-graph behavior. Either feedback path regenerates and reopens the review screen on the previously selected task when it still exists.

## Modes

Use the custom review component only in TUI mode. RPC and other non-TUI clients retain the existing selection/dialog flow.

## Safety

Review remains a trust boundary: no graph is persisted or executed until approval. Cancellation and UI failures cannot start execution. Component timers are disposed when the custom UI closes.

## Testing

Cover navigation, task-specific and general actions, confirmed cancellation, display-width bounds with wide characters, and fallback behavior outside TUI mode.
