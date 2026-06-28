# opencode-session-janitor

OpenCode plugin for cleaning up old local sessions with a safe startup dry-run.
It does not expose an agent-callable custom tool.

The plugin is safe by default: startup runs always perform a dry run and never
delete sessions.

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

When OpenCode loads the plugin, it runs one startup dry-run evaluation. The
summary is written through OpenCode's app log with candidate counts, skipped
counts, warnings, and config metadata.

`dryRun: false` is ignored for startup plugin runs in this version. Startup and
agent-callable deletion are not available; the programmatic API still retains
explicit delete-mode primitives for controlled callers.

## Configuration

Recommended project config file:

```json
{
  "retentionDays": 30,
  "dryRun": true
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
| `maxDeleteCount`        | `10`      | Maximum sessions deleted in one run, or `unlimited`. |
| `trigger`               | `startup` | Hook-driven trigger to use in a supported stage.     |
| `allowAutoDelete`       | `false`   | Reserved safety gate for future automatic deletion.  |

Unknown options are reported as warnings. In delete mode, warnings block the run
so a typo cannot silently delete sessions with unintended defaults.

If the default `.opencode/session-janitor.json` file is missing, it is ignored.
If an explicit `configFile` path is missing or invalid, the run fails before
listing or deleting sessions.

## Safety

- Startup runs are always dry-run only.
- Shared sessions and the current session are protected by default.
- Sessions with missing, invalid, or ambiguous metadata are skipped.
- Delete mode refuses to run if the current session cannot be identified while
  current-session protection is enabled.
- No agent-callable `session_janitor` tool is registered.
- The plugin uses OpenCode session APIs and does not edit storage files directly.

## Current Scope

This version implements startup dry-run only. It does not perform automatic
deletion and does not provide a manual custom tool.

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
