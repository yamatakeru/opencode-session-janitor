# opencode-session-janitor

OpenCode plugin for cleaning up old local sessions with a safe startup dry-run
and explicit opt-in auto delete.
It does not expose an agent-callable custom tool.

The plugin is safe by default: startup runs perform a dry run and never delete
sessions unless both `dryRun: false` and `allowAutoDelete: true` are explicitly
configured.

## Install

```sh
npm install opencode-session-janitor
```

Add the plugin to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-session-janitor"]
}
```

Then create either a user-wide config file at
`~/.config/opencode/session-janitor.json` or a project config file at
`.opencode/session-janitor.json`:

```json
{
  "retentionDays": 30,
  "dryRun": true,
  "maxDeleteCount": 10
}
```

OpenCode uses the singular top-level `plugin` key. The dedicated janitor config
files keep cleanup settings separate from the OpenCode config schema.

The package root is the OpenCode plugin entrypoint. Programmatic APIs are
available from the `opencode-session-janitor/api` subpath.

## Usage

When OpenCode loads the plugin, it runs one startup dry-run evaluation. The
summary is written through OpenCode's app log with candidate counts, skipped
counts, warnings, and config metadata.

When `notifyTui` is enabled, the plugin also attempts a short best-effort TUI
toast summary. Toast failures are ignored because the TUI may not be connected
yet; the app log remains the authoritative record.

If auto delete is explicitly enabled, the startup dry-run arms at most one
delete run. Deletion starts only after the plugin observes a trusted
session-scoped hook, currently `chat.message` or `command.execute.before`, and
uses that hook's `sessionID` for current-session protection. If no trusted hook
is observed, no delete run starts. Agent-callable deletion is not available.

## Configuration

Recommended config file:

```json
{
  "retentionDays": 30,
  "dryRun": true
}
```

Configuration precedence is:

1. Built-in safe defaults.
2. `$XDG_CONFIG_HOME/opencode/session-janitor.json`, or
   `~/.config/opencode/session-janitor.json` when `XDG_CONFIG_HOME` is unset.
3. `.opencode/session-janitor.json` in the current OpenCode worktree.
4. OpenCode plugin tuple options.

To use different config file paths, pass `globalConfigFile` or
`projectConfigFile` as plugin options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-session-janitor",
      {
        "globalConfigFile": "/Users/you/.config/opencode/session-janitor.json",
        "projectConfigFile": ".opencode/session-janitor.json"
      }
    ]
  ]
}
```

Set `globalConfigFile: false` or `projectConfigFile: false` to disable either
file layer. `globalConfigFile` paths must be absolute or start with `~/`.
Relative `projectConfigFile` paths are resolved from the OpenCode worktree.

| Option                  | Default   | Description                                          |
| ----------------------- | --------- | ---------------------------------------------------- |
| `retentionDays`         | `30`      | Delete candidates must be older than this many days. |
| `dryRun`                | `true`    | Preview only when enabled.                           |
| `includeShared`         | `false`   | Include shared sessions as delete candidates.        |
| `excludeCurrentSession` | `true`    | Protect the currently running session.               |
| `maxDeleteCount`        | `10`      | Maximum sessions deleted in one run, or `unlimited`. |
| `trigger`               | `startup` | Hook-driven trigger to use in a supported stage.     |
| `allowAutoDelete`       | `false`   | Required safety gate for startup auto delete.        |
| `notifyTui`             | `true`    | Show a best-effort TUI toast summary when available. |

Unknown options are reported as warnings. In delete mode, warnings block the run
so a typo cannot silently delete sessions with unintended defaults.

Missing default global or project config files are ignored. Existing config
files that are invalid, unreadable, or not JSON objects fail before listing or
deleting sessions. Missing explicit config file paths also fail before listing
or deleting sessions.

## Safety

- Startup auto delete requires `dryRun: false` and `allowAutoDelete: true`.
- Startup auto delete also requires `trigger: "startup"` and
  `excludeCurrentSession: true`.
- First run with `dryRun: true` is strongly recommended before enabling delete.
- The global config file is user-wide policy. Setting `dryRun: false` and
  `allowAutoDelete: true` there can enable startup auto delete in every project
  that loads this plugin unless a higher-precedence source overrides it.
- Shared sessions and the current session are protected by default.
- Setting `includeShared: true` allows startup auto delete to delete old shared
  sessions, which may invalidate shared URLs.
- Sessions with missing, invalid, or ambiguous metadata are skipped.
- Delete mode refuses to run if the current session cannot be identified while
  current-session protection is enabled.
- Delete mode also refuses to run if the trusted current session ID is not
  present in OpenCode's session list.
- Startup auto delete waits for a trusted `chat.message` or
  `command.execute.before` hook before deleting, and does not use
  `session.idle` or `session.status` events as the current-session source.
- No agent-callable `session_janitor` tool is registered.
- The plugin uses OpenCode session APIs and does not edit storage files directly.
- Deletion is irreversible.

## Auto Delete

To enable automatic deletion, configure all required gates:

```json
{
  "retentionDays": 30,
  "dryRun": false,
  "allowAutoDelete": true,
  "excludeCurrentSession": true,
  "includeShared": false,
  "maxDeleteCount": 10,
  "trigger": "startup"
}
```

Auto delete is armed by the startup dry-run and runs once per plugin instance
only after the plugin observes `chat.message` or `command.execute.before` for a
trusted session ID. If neither trusted hook is observed, auto delete does not
run. `session.idle` auto delete is intentionally not enabled in this version
because its trigger timing is harder to reason about safely.

If a later trusted hook reports a different session ID while startup auto delete
is still running, the plugin cancels the remaining delete loop on a best-effort
basis. An individual `session.delete` call that is already in flight may still
complete because OpenCode deletion is irreversible once processed.

## Current Scope

This version implements startup dry-run and explicit opt-in startup auto delete.
It does not provide a manual custom tool or scheduled background cleanup.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm run format` checks formatting with Prettier.

## Runtime Smoke Test

Before releasing startup auto delete changes, test against a disposable OpenCode
environment because deletion is irreversible.

1. Install the local plugin and configure `dryRun: false`,
   `allowAutoDelete: true`, `excludeCurrentSession: true`,
   `trigger: "startup"`, and a small `maxDeleteCount`.
2. Start OpenCode, send a normal chat message, and confirm the app log shows the
   startup dry-run followed by at most one delete run.
3. Repeat with an OpenCode command that triggers `command.execute.before`.
4. Confirm no guard error says the current session ID was missing from the
   session list.
5. If the active test session is old enough to be a delete candidate, confirm it
   is skipped with reason `current_session`.

For local plugin development, prefer installing the package into the OpenCode
project or using a small auto-discovered wrapper instead of pointing config at a
`dist/` file directly:

```js
// .opencode/plugins/session-janitor.js
export { server } from "opencode-session-janitor";
```

Restart OpenCode after changing plugin configuration, changing janitor config
files, or rebuilding the package.

## Compatibility

Implemented against `@opencode-ai/plugin` and `@opencode-ai/sdk` 1.17.11.
