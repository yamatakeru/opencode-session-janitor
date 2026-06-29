import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";

import {
  getCleanupOptions,
  resolveConfigFromSources,
  type ResolvedSessionJanitorConfig,
  type SessionJanitorPluginOptions,
} from "./config.js";
import { loadSessionJanitorConfigFile } from "./config-file.js";
import { safeShowTuiToast, shouldNotifyTui } from "./janitor-notifier.js";
import { runSessionJanitor } from "./janitor.js";
import type { SessionJanitorClient } from "./janitor-session-client.js";
import { formatUnknownError } from "./janitor-session-client.js";

const serviceName = "opencode-session-janitor";
const delayedStartupToastDelayMs = 3000;

type StartupLoggingResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };
type StartupRunKind = "dry-run" | "auto delete";

const SessionJanitorPlugin: Plugin = async function SessionJanitorPlugin(
  input,
  options,
) {
  const pluginOptions = options as SessionJanitorPluginOptions | undefined;
  let autoDeleteStarted = false;
  const startupDryRun = Promise.resolve()
    .then(() =>
      runSessionJanitor({
        client: input.client,
        pluginOptions,
        configFileBaseDir: input.worktree,
        trigger: "startup",
        forceDryRun: true,
        suppressTuiToast: true,
      }),
    )
    .then((result) => {
      reportStartupResultProblems("dry-run", result);
      scheduleDelayedStartupToast(input.client, result.metadata);
      return result;
    })
    .catch((error: unknown) => {
      void reportStartupError("dry-run", input.client, error);
      return undefined;
    });

  void startupDryRun;

  return {
    event: async ({ event }) => {
      if (autoDeleteStarted) {
        return;
      }

      const currentSessionID = getCurrentSessionIDFromEvent(event);
      if (currentSessionID === undefined) {
        return;
      }

      autoDeleteStarted = true;
      const dryRunResult = await startupDryRun;
      if (dryRunResult?.metadata.ok !== true) {
        return;
      }

      const autoDeleteConfig = await getStartupAutoDeleteConfig({
        pluginOptions,
        configFileBaseDir: input.worktree,
      });
      if (
        autoDeleteConfig === undefined ||
        !matchesForcedDryRunConfig(
          dryRunResult.metadata.config,
          autoDeleteConfig,
        )
      ) {
        return;
      }

      void runSessionJanitor({
        client: input.client,
        pluginOptions: { ...autoDeleteConfig, configFile: false },
        configFileBaseDir: input.worktree,
        currentSessionID,
        trigger: "startup",
      })
        .then((result) => reportStartupResultProblems("auto delete", result))
        .catch((error: unknown) => {
          void reportStartupError("auto delete", input.client, error);
        });
    },
  };
};

async function getStartupAutoDeleteConfig(input: {
  pluginOptions: SessionJanitorPluginOptions | undefined;
  configFileBaseDir: string;
}): Promise<ResolvedSessionJanitorConfig | undefined> {
  const configFile = await loadSessionJanitorConfigFile({
    baseDir: input.configFileBaseDir,
    pluginOptions: input.pluginOptions,
  });
  if (configFile.errors.length > 0) {
    return undefined;
  }

  const validation = resolveConfigFromSources(
    configFile.options,
    getCleanupOptions(input.pluginOptions),
  );
  if (
    validation.ok &&
    validation.warnings.length === 0 &&
    validation.config.trigger === "startup" &&
    validation.config.dryRun === false &&
    validation.config.allowAutoDelete === true
  ) {
    return validation.config;
  }

  return undefined;
}

function scheduleDelayedStartupToast(
  client: SessionJanitorClient,
  metadata: Record<string, unknown>,
): void {
  if (!shouldNotifyTui(metadata)) {
    return;
  }

  const timer = setTimeout(() => {
    void showDelayedStartupToast(client, metadata);
  }, delayedStartupToastDelayMs);
  timer.unref?.();
}

async function showDelayedStartupToast(
  client: SessionJanitorClient,
  metadata: Record<string, unknown>,
): Promise<void> {
  const notification = await safeShowTuiToast(client, metadata);
  await safeLogDelayedStartupToast(client, notification, metadata);
}

async function safeLogDelayedStartupToast(
  client: SessionJanitorClient,
  notification: StartupLoggingResult,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!client.app?.log) {
    return;
  }

  try {
    await client.app.log({
      body: {
        service: serviceName,
        level: notification.ok ? "info" : "warn",
        message: notification.ok
          ? "Session janitor delayed TUI toast completed"
          : "Session janitor delayed TUI toast failed",
        extra: {
          trigger: "startup",
          mode: metadata.mode,
          candidateCount: metadata.candidateCount,
          tuiNotification: notification,
        },
      },
    });
  } catch {
    // The delayed toast is diagnostic only; logging failures must not affect startup.
  }
}

function matchesForcedDryRunConfig(
  dryRunConfig: unknown,
  autoDeleteConfig: ResolvedSessionJanitorConfig,
): boolean {
  if (typeof dryRunConfig !== "object" || dryRunConfig === null) {
    return false;
  }

  const config = dryRunConfig as Partial<ResolvedSessionJanitorConfig>;
  return (
    config.retentionDays === autoDeleteConfig.retentionDays &&
    config.dryRun === true &&
    config.includeShared === autoDeleteConfig.includeShared &&
    config.excludeCurrentSession === autoDeleteConfig.excludeCurrentSession &&
    config.maxDeleteCount === autoDeleteConfig.maxDeleteCount &&
    config.trigger === autoDeleteConfig.trigger &&
    config.allowAutoDelete === autoDeleteConfig.allowAutoDelete &&
    config.notifyTui === autoDeleteConfig.notifyTui
  );
}

function getCurrentSessionIDFromEvent(event: Event): string | undefined {
  if (!isCurrentSessionEvent(event.type)) {
    return undefined;
  }

  const properties = (event as { properties?: Record<string, unknown> })
    .properties;
  if (!properties) {
    return undefined;
  }

  const sessionID = properties.sessionID;
  if (typeof sessionID === "string" && sessionID.trim().length > 0) {
    return sessionID;
  }

  return undefined;
}

function isCurrentSessionEvent(type: Event["type"]): boolean {
  return type === "session.idle" || type === "session.status";
}

function reportStartupResultProblems(
  kind: StartupRunKind,
  result: Awaited<ReturnType<typeof runSessionJanitor>>,
): void {
  const logging = result.metadata.logging;
  if (isStartupLoggingFailure(logging)) {
    console.warn(
      `Session janitor startup ${kind} could not be logged: ${logging.error}\n\n${result.output}`,
    );
    return;
  }
  if (result.metadata.ok === false) {
    console.warn(`Session janitor startup ${kind} failed\n\n${result.output}`);
  }
}

async function reportStartupError(
  kind: StartupRunKind,
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
          message: `Session janitor startup ${kind} failed unexpectedly`,
          extra: { trigger: "startup", error: formatted },
        },
      });
      return;
    } catch (logError) {
      console.warn(
        `Session janitor startup ${kind} failed unexpectedly: ${formatted}\n` +
          `Also failed to log startup ${kind} error: ${formatUnknownError(logError)}`,
      );
      return;
    }
  }

  console.warn(
    `Session janitor startup ${kind} failed unexpectedly: ${formatted}`,
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
