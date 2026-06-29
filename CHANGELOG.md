# Changelog

## Unreleased

- Added startup dry-run evaluation when the plugin loads.
- Removed the agent-callable `session_janitor` custom tool.
- Removed per-run tool arguments as a cleanup policy source.
- Added explicit opt-in startup auto delete behind `dryRun: false` and `allowAutoDelete: true`.
- Changed plugin startup to run an initial forced dry-run, then wait for a session ID before any auto delete.
- Added best-effort TUI toast summaries via `notifyTui`.
- Allowed explicit `includeShared: true` startup auto delete to delete old shared sessions.
- Removed `minSessionsToKeep` from cleanup configuration.
- Added `maxDeleteCount: "unlimited"` as an explicit no-cap delete-count option.

## 0.1.0

- Added Stage 1 manual `session_janitor` custom tool MVP.
- Added safe config defaults, validation, dry-run output, deletion execution, and tests.
- Added support for project settings in `.opencode/session-janitor.json`.
- Startup dry-run and automatic deletion are not implemented in this stage.
