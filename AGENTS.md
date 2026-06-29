# AGENTS.md

## Project Role

This repository contains `opencode-session-janitor`, a TypeScript npm package
for an OpenCode plugin that safely cleans up old local OpenCode sessions.

This file is for coding agents working on this repository. It is not user
documentation.

## Current Scope

Current implementation: OpenCode plugin startup runs perform a dry-run session
cleanup evaluation, with explicit opt-in startup auto delete available behind
strong safety gates. The manual `session_janitor` custom tool has been removed
from the agent-callable surface.

Implemented:

- startup dry-run
- explicit opt-in startup auto delete
- no agent-callable custom tool
- dry-run evaluation
- explicit delete mode
- config validation
- safety guards
- tests for config, evaluation, janitor behavior, and plugin registration

Not implemented:

- scheduled or background cleanup

Do not expand beyond the current stage unless the user explicitly asks.

## Safety Invariants

Preserve these behaviors:

- `dryRun` defaults to `true`.
- Delete mode only runs when `dryRun: false` is explicitly configured or passed.
- Shared sessions are protected by default and may be deleted by startup auto
  delete only when `includeShared: true` is explicitly configured.
- The current session is protected by default.
- Sessions with missing, invalid, or ambiguous timestamps are skipped.
- Config validation failures must prevent deletion.
- Unknown option warnings must block delete mode.
- If the current session ID is unavailable, delete mode must fail closed.
- User-wide config is read before project config; project config and plugin
  options may override it.
- Do not directly edit OpenCode database or storage files.
- Use OpenCode SDK/API methods for listing and deleting sessions.

## OpenCode Compatibility

The plugin currently targets:

- `@opencode-ai/plugin` 1.17.11
- `@opencode-ai/sdk` 1.17.11

When changing plugin registration, tool registration, or SDK calls, verify the
behavior against this API shape.

## Code Map

- `src/index.ts`: plugin entrypoint.
- `src/config.ts`: config defaults, merging, validation, and unknown options.
- `src/config-file.ts`: user-wide and project config file discovery/loading.
- `src/evaluate.ts`: session eligibility, age calculation, and skip reasons.
- `src/janitor.ts`: list/evaluate/delete orchestration, logging, output, and cancellation.
- `test/`: Vitest tests for config, evaluation, plugin registration, and janitor behavior.

## Development Commands

Run the relevant checks before considering changes complete:

```sh
npm run typecheck
npm test
npm run build
npm run format
```

## Future Stage Guardrails

Startup auto delete is allowed only behind strong gates such as `dryRun: false`
and `allowAutoDelete: true`.

Do not introduce background deletion, scheduled deletion, or relaxed safety
rules as incidental refactors.

## Documentation Policy

- `README.md` is user-facing documentation.
- `CHANGELOG.md` is for release-visible changes.
- `AGENTS.md` is for repository-level coding-agent instructions.
- Internal plans or todos should not be copied into README or AGENTS in full.

Keep README normal-sized. Prefer concise safety and usage documentation over
implementation-detail dumps.

## Working Style

Prefer small, explicit changes over broad refactors.

When changing cleanup eligibility, config validation, or delete behavior, add or
update tests.

Reviews are useful when they identify real risks. Avoid letting review loops
turn into excessive fixes, cosmetic churn, or locally over-detailed
documentation that distorts the overall documentation balance.
