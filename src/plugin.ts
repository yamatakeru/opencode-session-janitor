import type { Plugin } from "@opencode-ai/plugin";

import type { SessionJanitorPluginOptions } from "./config.js";
import { runSessionJanitor } from "./janitor.js";

type StartupLoggingResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };

const SessionJanitorPlugin: Plugin = async function SessionJanitorPlugin(
  input,
  options,
) {
  const pluginOptions = options as SessionJanitorPluginOptions | undefined;

  const result = await runSessionJanitor({
    client: input.client,
    pluginOptions,
    configFileBaseDir: input.worktree,
    trigger: "startup",
  });

  const logging = result.metadata.logging;
  if (isStartupLoggingFailure(logging)) {
    throw new Error(
      `Session janitor startup dry-run could not be logged: ${logging.error}\n\n${result.output}`,
    );
  }
  if (result.metadata.ok === false) {
    throw new Error(
      `Session janitor startup dry-run failed\n\n${result.output}`,
    );
  }

  return {};
};

function isStartupLoggingFailure(
  value: unknown,
): value is StartupLoggingResult & { ok: false } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === false &&
    "error" in value &&
    typeof value.error === "string"
  );
}

export default SessionJanitorPlugin;
