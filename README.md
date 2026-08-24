# Pi Plugins

Small, reusable extensions for the [pi coding agent](https://pi.dev).

## Install

```bash
pi install git:github.com/caidanw/pi-plugins
```

Restart pi after installation. Update later with:

```bash
pi update --extensions
```

## Extensions

### Automatic session titles

Names a new session once its first request settles. It prefers an available cheap model and falls back to the active model. Automatic naming never overwrites an existing name.

Use `/rename-session` to regenerate the title from the current conversation.

### `/undo`

Moves the active session to immediately before the latest user turn and restores that prompt for editing. Session history remains available in `/tree`. Files changed during the turn are not reverted.

### Plan execution

Turn a Markdown implementation plan into an approved task DAG, then run each task with a fresh worker:

```text
/execute-plan docs/plans/feature.md
```

The planner submits tasks through a validated structured-output tool. Review every generated task and verification command before choosing **Approve and run**. In the TUI, a focused dashboard shows planning, tool activity, task progress, verification output, repairs, and the final audit. Press `Esc` twice within two seconds to pause or stop and exit.

Execution is sequential. For new graphs, the controller requires a clean implementation tree, verifies each task, and creates a `plan(<task-id>): <title>` commit before advancing. It allows one repair attempt, preserves resumable state in a sibling `.tasks.json` file, and writes an advisory final audit to `.audit.md`. Use `/plan-resume` to find unfinished plans in the current repository; `/plan-status` and `/plan-stop` remain available from non-TUI clients. Do not edit the checkout from another process while workers are active.

## Security

Pi extensions run with your full system permissions. Review extension source before installing. Plan execution runs approved, model-generated verification commands through your shell with your permissions. Workers are not OS-sandboxed, so do not execute untrusted plans.

## License

MIT
