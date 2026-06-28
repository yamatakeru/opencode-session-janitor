# Changelog

## Unreleased

- Removed the agent-callable `session_janitor` custom tool.
- Removed per-run tool arguments as a cleanup policy source.
- Changed the default trigger from `manual` to `startup` for the planned hook-driven path.

## 0.1.0

- Added Stage 1 manual `session_janitor` custom tool MVP.
- Added safe config defaults, validation, dry-run output, deletion execution, and tests.
- Added support for project settings in `.opencode/session-janitor.json`.
- Startup dry-run and automatic deletion are not implemented in this stage.
