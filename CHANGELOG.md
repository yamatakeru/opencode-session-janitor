# Changelog

## Unreleased

- Added startup dry-run evaluation when the plugin loads.
- Removed the agent-callable `session_janitor` custom tool.
- Removed per-run tool arguments as a cleanup policy source.
- Added explicit opt-in startup auto delete behind `dryRun: false` and `allowAutoDelete: true`.
- Changed startup auto delete to arm after the initial forced dry-run, then wait for a trusted `chat.message` or `command.execute.before` session hook before deleting.
- Stopped using generic `session.idle` or `session.status` events as the current-session source for startup auto delete.
- Added a delete-mode guard that fails closed when the trusted current session ID is not present in OpenCode's session list.
- Documented that cancellation can stop remaining delete candidates, but an in-flight OpenCode `session.delete` call may still complete.
- Added a runtime smoke-test checklist for verifying trusted hook session IDs against real OpenCode behavior.
- Added best-effort TUI toast summaries via `notifyTui`.
- Allowed explicit `includeShared: true` startup auto delete to delete old shared sessions.
- Added user-wide config loading from `~/.config/opencode/session-janitor.json` with project config overriding global config.
- Replaced the `configFile` plugin option with `globalConfigFile` and `projectConfigFile`.
- Removed `minSessionsToKeep` from cleanup configuration.
- Added `maxDeleteCount: "unlimited"` as an explicit no-cap delete-count option.

## 0.1.0

- Added Stage 1 manual `session_janitor` custom tool MVP.
- Added safe config defaults, validation, dry-run output, deletion execution, and tests.
- Added support for project settings in `.opencode/session-janitor.json`.
- Startup dry-run and automatic deletion are not implemented in this stage.
