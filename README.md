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

## Security

Pi extensions run with your full system permissions. Review extension source before installing.

## License

MIT
