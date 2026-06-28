# opencode-session-janitor

OpenCode plugin for cleaning up old local sessions. It provides a manual custom
tool named `session_janitor`.

The plugin is safe by default: it only performs a dry run unless you explicitly
set `dryRun: false`.

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

Then create `.opencode/session-janitor.json` in the project:

```json
{
  "retentionDays": 30,
  "dryRun": true,
  "maxDeleteCount": 10
}
```

OpenCode uses the singular top-level `plugin` key. The dedicated
`.opencode/session-janitor.json` file keeps janitor settings separate from the
OpenCode config schema.

The package root is the OpenCode plugin entrypoint. Programmatic APIs are
available from the `opencode-session-janitor/api` subpath.

## Usage

Ask OpenCode to run the `session_janitor` tool. With the default configuration,
it previews sessions that would be deleted and explains why other sessions were
skipped.

You can override options for a single run:

```json
{
  "retentionDays": 14,
  "dryRun": true,
  "maxDeleteCount": 5
}
```

To actually delete sessions, run the tool with `dryRun: false`:

```json
{
  "dryRun": false,
  "retentionDays": 30,
  "maxDeleteCount": 3
}
```

Deletion is irreversible. Review a dry run before using delete mode.

## Configuration

Recommended project config file:

```json
{
  "retentionDays": 30,
  "dryRun": true,
  "includeShared": false,
  "excludeCurrentSession": true,
  "minSessionsToKeep": 0,
  "maxDeleteCount": 10
}
```

Configuration precedence is:

1. Built-in safe defaults.
2. `.opencode/session-janitor.json`.
3. OpenCode plugin tuple options.
4. Per-run `session_janitor` tool arguments.

To use a different config file, pass `configFile` as a plugin option:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-session-janitor",
      {
        "configFile": ".opencode/session-janitor.json"
      }
    ]
  ]
}
```

Set `configFile: false` to disable dedicated config file loading.

| Option                  | Default | Description                                          |
| ----------------------- | ------- | ---------------------------------------------------- |
| `retentionDays`         | `30`    | Delete candidates must be older than this many days. |
| `dryRun`                | `true`  | Preview only when enabled.                           |
| `includeShared`         | `false` | Include shared sessions as delete candidates.        |
| `excludeCurrentSession` | `true`  | Protect the currently running session.               |
| `minSessionsToKeep`     | `0`     | Always keep at least this many newest sessions.      |
| `maxDeleteCount`        | `10`    | Maximum sessions deleted in one run.                 |

Unknown options are reported as warnings. In delete mode, warnings block the run
so a typo cannot silently delete sessions with unintended defaults.

If the default `.opencode/session-janitor.json` file is missing, it is ignored.
If an explicit `configFile` path is missing or invalid, the run fails before
listing or deleting sessions.

## Safety

- Dry run is the default.
- Shared sessions and the current session are protected by default.
- Sessions with missing, invalid, or ambiguous metadata are skipped.
- Delete mode refuses to run if the current session cannot be identified while
  current-session protection is enabled.
- The plugin uses OpenCode session APIs and does not edit storage files directly.

## Current Scope

This version only implements the manual `session_janitor` tool. It does not run
automatically on startup and does not perform automatic deletion.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

`npm run format` checks formatting with Prettier.

For local plugin development, prefer installing the package into the OpenCode
project or using a small auto-discovered wrapper instead of pointing config at a
`dist/` file directly:

```js
// .opencode/plugins/session-janitor.js
export { server } from "opencode-session-janitor";
```

Restart OpenCode after changing plugin configuration, changing
`.opencode/session-janitor.json`, or rebuilding the package.

## Compatibility

Implemented against `@opencode-ai/plugin` and `@opencode-ai/sdk` 1.17.11.
