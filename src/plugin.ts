import type { Plugin } from "@opencode-ai/plugin";

import type { SessionJanitorPluginOptions } from "./config.js";
import type { SessionJanitorClient } from "./janitor-session-client.js";
import { formatUnknownError } from "./janitor-session-client.js";
import { runSessionJanitor } from "./janitor.js";

const serviceName = "opencode-session-janitor";

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

  queueMicrotask(() => {
    void runSessionJanitor({
      client: input.client,
      pluginOptions,
      configFileBaseDir: input.worktree,
      trigger: "startup",
    })
      .then(reportStartupDryRunResultProblems)
      .catch((error: unknown) => {
        void reportStartupDryRunError(input.client, error);
      });
  });

  return {};
};

function reportStartupDryRunResultProblems(
  result: Awaited<ReturnType<typeof runSessionJanitor>>,
): void {
  const logging = result.metadata.logging;
  if (isStartupLoggingFailure(logging)) {
    console.warn(
      `Session janitor startup dry-run could not be logged: ${logging.error}\n\n${result.output}`,
    );
    return;
  }
  if (result.metadata.ok === false) {
    console.warn(`Session janitor startup dry-run failed\n\n${result.output}`);
  }
}

async function reportStartupDryRunError(
  client: SessionJanitorClient,
  error: unknown,
): Promise<void> {
  const formatted = formatUnknownError(error);
  if (client.app?.log) {
    try {
      await client.app.log({
        body: {
          service: serviceName,
          level: "error",
          message: "Session janitor startup dry-run failed unexpectedly",
          extra: { trigger: "startup", error: formatted },
        },
      });
      return;
    } catch (logError) {
      console.warn(
        `Session janitor startup dry-run failed unexpectedly: ${formatted}\n` +
          `Also failed to log startup dry-run error: ${formatUnknownError(logError)}`,
      );
      return;
    }
  }

  console.warn(
    `Session janitor startup dry-run failed unexpectedly: ${formatted}`,
  );
}

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
