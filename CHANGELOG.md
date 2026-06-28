# Changelog

## Unreleased

- Added startup dry-run evaluation when the plugin loads.
- Removed the agent-callable `session_janitor` custom tool.
- Removed per-run tool arguments as a cleanup policy source.
- Changed startup runs to force dry-run mode even when config requests deletion.
- Removed `minSessionsToKeep` from cleanup configuration.
- Added `maxDeleteCount: "unlimited"` as an explicit no-cap delete-count option.

## 0.1.0

- Added Stage 1 manual `session_janitor` custom tool MVP.
- Added safe config defaults, validation, dry-run output, deletion execution, and tests.
- Added support for project settings in `.opencode/session-janitor.json`.
- Startup dry-run and automatic deletion are not implemented in this stage.
