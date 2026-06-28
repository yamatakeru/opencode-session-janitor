# opencode-session-janitor

OpenCode plugin for cleaning up old local sessions with a safe retention policy.
It does not expose an agent-callable custom tool.

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

Cleanup policy is defined only by `.opencode/session-janitor.json` and plugin
tuple options. The plugin intentionally does not register a `session_janitor`
custom tool, so a model cannot trigger deletion or override policy with
generated tool arguments.

Startup dry-run is the next planned execution path. This version removes the
manual tool surface but does not yet run automatically on startup.

Deletion is irreversible. Keep `dryRun: true` until you have reviewed a dry-run
summary from a supported hook-driven run.

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

| Option                  | Default   | Description                                          |
| ----------------------- | --------- | ---------------------------------------------------- |
| `retentionDays`         | `30`      | Delete candidates must be older than this many days. |
| `dryRun`                | `true`    | Preview only when enabled.                           |
| `includeShared`         | `false`   | Include shared sessions as delete candidates.        |
| `excludeCurrentSession` | `true`    | Protect the currently running session.               |
| `minSessionsToKeep`     | `0`       | Always keep at least this many newest sessions.      |
| `maxDeleteCount`        | `10`      | Maximum sessions deleted in one run.                 |
| `trigger`               | `startup` | Hook-driven trigger to use in a supported stage.     |
| `allowAutoDelete`       | `false`   | Reserved safety gate for future automatic deletion.  |

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

This version removes the manual `session_janitor` tool. It does not run
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
