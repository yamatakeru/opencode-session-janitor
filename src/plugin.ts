import type { Plugin } from "@opencode-ai/plugin";

import {
  getCleanupOptions,
  resolveConfigFromOptionSources,
  type ResolvedSessionJanitorConfig,
  type SessionJanitorPluginOptions,
} from "./config.js";
import { loadSessionJanitorConfigFile } from "./config-file.js";
import { safeShowTuiToast, shouldNotifyTui } from "./janitor-notifier.js";
import { runSessionJanitor } from "./janitor.js";
import type {
  LogLevel,
  SessionJanitorClient,
} from "./janitor-session-client.js";
import {
  formatUnknownError,
  unwrapResponse,
} from "./janitor-session-client.js";

const serviceName = "opencode-session-janitor";
const delayedStartupToastDelayMs = 3000;

type StartupLoggingResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };
type StartupRunKind = "dry-run" | "auto delete";
type TrustedSessionSource = "chat.message" | "command.execute.before";
type TrustedStartupSessionObservation = {
  trustedSessionID: string;
  trustedSessionSource: TrustedSessionSource;
};
type StartupAutoDeleteConfigResult =
  | { kind: "ready"; config: ResolvedSessionJanitorConfig }
  | { kind: "not-enabled" }
  | { kind: "blocked"; errors: string[]; warnings: string[] };

const SessionJanitorPlugin: Plugin = async function SessionJanitorPlugin(
  input,
  options,
) {
  const pluginOptions = options as SessionJanitorPluginOptions | undefined;
  let autoDeleteStarted = false;
  let autoDeleteBlocked = false;
  let autoDeleteRunCompleted = false;
  let autoDeleteAbortController: AbortController | undefined;
  let trustedStartupSession: TrustedStartupSessionObservation | undefined;
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

  function observeTrustedStartupSession({
    trustedSessionID,
    trustedSessionSource,
  }: TrustedStartupSessionObservation): void {
    const normalizedTrustedSessionID = trustedSessionID.trim();

    if (normalizedTrustedSessionID.length === 0) {
      return;
    }
    if (normalizedTrustedSessionID !== trustedSessionID) {
      blockStartupAutoDeleteFromTrustedSession({
        trustedSessionSource,
        errors: [
          "Refusing startup auto delete because trusted sessionID was not normalized.",
        ],
      });
      return;
    }

    const observation = {
      trustedSessionID: normalizedTrustedSessionID,
      trustedSessionSource,
    };

    if (
      trustedStartupSession &&
      trustedStartupSession.trustedSessionID !== observation.trustedSessionID
    ) {
      if (!autoDeleteRunCompleted) {
        blockStartupAutoDeleteFromTrustedSession({
          trustedSessionSource,
          errors: [
            "Refusing startup auto delete because multiple trusted session hooks reported different session IDs.",
          ],
          extra: {
            firstTrustedSessionSource:
              trustedStartupSession.trustedSessionSource,
            conflictingTrustedSessionSource: trustedSessionSource,
          },
        });
      }
      return;
    }

    if (autoDeleteStarted) {
      return;
    }

    trustedStartupSession = observation;
    autoDeleteStarted = true;
    void startStartupAutoDeleteFromTrustedSession(observation).catch(
      (error: unknown) => {
        void reportStartupError("auto delete", input.client, error, {
          autoDeleteTrigger: "startup-armed",
          trustedSessionSource,
        });
      },
    );
  }

  async function startStartupAutoDeleteFromTrustedSession({
    trustedSessionID,
    trustedSessionSource,
  }: TrustedStartupSessionObservation): Promise<void> {
    const blockLogMetadata =
      getTrustedStartupAutoDeleteMetadata(trustedSessionSource);

    try {
      const dryRunResult = await startupDryRun;
      if (autoDeleteBlocked) {
        return;
      }
      if (dryRunResult?.metadata.ok !== true) {
        return;
      }
      const dryRunLogging = dryRunResult.metadata.logging;
      if (isStartupLoggingFailure(dryRunLogging)) {
        await reportStartupAutoDeleteBlocked(
          input.client,
          {
            kind: "blocked",
            errors: [
              `Refusing startup auto delete because the startup dry-run could not be logged: ${dryRunLogging.error}`,
            ],
            warnings: [],
          },
          blockLogMetadata,
        );
        return;
      }

      const autoDeleteConfig = await getStartupAutoDeleteConfig({
        pluginOptions,
        configFileBaseDir: input.worktree,
      });
      if (autoDeleteConfig.kind === "blocked") {
        await reportStartupAutoDeleteBlocked(
          input.client,
          autoDeleteConfig,
          blockLogMetadata,
        );
        return;
      }
      if (autoDeleteConfig.kind !== "ready") {
        return;
      }
      if (
        !matchesForcedDryRunConfig(
          dryRunResult.metadata.config,
          autoDeleteConfig.config,
        )
      ) {
        await reportStartupAutoDeleteBlocked(
          input.client,
          {
            kind: "blocked",
            errors: [
              "Refusing startup auto delete because config changed after the startup dry-run.",
            ],
            warnings: [],
          },
          blockLogMetadata,
        );
        return;
      }
      if (autoDeleteBlocked) {
        return;
      }

      const abortController = new AbortController();
      autoDeleteAbortController = abortController;
      const result = await runSessionJanitor({
        client: input.client,
        pluginOptions: {
          ...autoDeleteConfig.config,
          globalConfigFile: false,
          projectConfigFile: false,
        },
        configFileBaseDir: input.worktree,
        currentSessionID: trustedSessionID,
        trigger: "startup",
        abortSignal: abortController.signal,
      });
      reportStartupResultProblems("auto delete", result);
    } finally {
      autoDeleteRunCompleted = true;
    }
  }

  function blockStartupAutoDeleteFromTrustedSession({
    trustedSessionSource,
    errors,
    extra = {},
  }: {
    trustedSessionSource: TrustedSessionSource;
    errors: string[];
    extra?: Record<string, unknown>;
  }): void {
    if (autoDeleteBlocked) {
      return;
    }

    autoDeleteBlocked = true;
    autoDeleteStarted = true;
    autoDeleteAbortController?.abort();
    const metadata = getTrustedStartupAutoDeleteMetadata(
      trustedSessionSource,
      extra,
    );
    void reportStartupAutoDeleteBlocked(
      input.client,
      {
        kind: "blocked",
        errors,
        warnings: [],
      },
      metadata,
    ).catch((error: unknown) => {
      void reportStartupError("auto delete", input.client, error, metadata);
    });
  }

  return {
    "chat.message": async (hookInput) => {
      observeTrustedStartupSession({
        trustedSessionID: hookInput.sessionID,
        trustedSessionSource: "chat.message",
      });
    },
    "command.execute.before": async (hookInput) => {
      observeTrustedStartupSession({
        trustedSessionID: hookInput.sessionID,
        trustedSessionSource: "command.execute.before",
      });
    },
  };
};

async function getStartupAutoDeleteConfig(input: {
  pluginOptions: SessionJanitorPluginOptions | undefined;
  configFileBaseDir: string;
}): Promise<StartupAutoDeleteConfigResult> {
  const configFile = await loadSessionJanitorConfigFile({
    baseDir: input.configFileBaseDir,
    pluginOptions: input.pluginOptions,
  });
  if (configFile.errors.length > 0) {
    return {
      kind: "blocked",
      errors: configFile.errors,
      warnings: configFile.warnings,
    };
  }

  const validation = resolveConfigFromOptionSources(
    configFile.optionSources,
    getCleanupOptions(input.pluginOptions),
  );
  if (!validation.ok) {
    return {
      kind: "blocked",
      errors: validation.errors,
      warnings: [...configFile.warnings, ...validation.warnings],
    };
  }

  const warnings = [...configFile.warnings, ...validation.warnings];

  if (validation.config.dryRun === false && warnings.length > 0) {
    return {
      kind: "blocked",
      errors: warnings.map(
        (warning) =>
          `Refusing delete because configuration was not fully recognized: ${warning}`,
      ),
      warnings,
    };
  }

  if (validation.config.dryRun === false) {
    const gateErrors = getStartupAutoDeleteGateErrors(validation.config);
    if (gateErrors.length > 0) {
      return { kind: "blocked", errors: gateErrors, warnings: [] };
    }
  }

  if (
    warnings.length === 0 &&
    validation.config.trigger === "startup" &&
    validation.config.dryRun === false &&
    validation.config.allowAutoDelete === true
  ) {
    return { kind: "ready", config: validation.config };
  }

  return { kind: "not-enabled" };
}

function getStartupAutoDeleteGateErrors(
  config: ResolvedSessionJanitorConfig,
): string[] {
  const errors: string[] = [];

  if (config.trigger !== "startup") {
    errors.push(
      "Refusing startup auto delete because trigger must be startup.",
    );
  }
  if (!config.allowAutoDelete) {
    errors.push(
      "Refusing startup auto delete because allowAutoDelete:true is required.",
    );
  }
  if (!config.excludeCurrentSession) {
    errors.push(
      "Refusing startup auto delete because excludeCurrentSession:true is required.",
    );
  }

  return errors;
}

function scheduleDelayedStartupToast(
  client: SessionJanitorClient,
  metadata: Record<string, unknown>,
): void {
  if (!shouldNotifyTui(metadata)) {
    return;
  }

  const timer = setTimeout(() => {
    void showDelayedStartupToast(client, metadata).catch((error: unknown) => {
      console.warn(
        `Session janitor delayed TUI toast failed unexpectedly: ${formatUnknownError(error)}`,
      );
    });
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
    if (!notification.ok) {
      console.warn(
        `Session janitor delayed TUI toast failed: ${notification.error}`,
      );
    }
    return;
  }

  try {
    await logToApp(
      client,
      notification.ok ? "info" : "warn",
      notification.ok
        ? "Session janitor delayed TUI toast completed"
        : "Session janitor delayed TUI toast failed",
      {
        trigger: "startup",
        mode: metadata.mode,
        candidateCount: metadata.candidateCount,
        tuiNotification: notification,
      },
    );
  } catch (error) {
    console.warn(
      `Session janitor delayed TUI toast log failed: ${formatUnknownError(error)}`,
    );
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

function getTrustedStartupAutoDeleteMetadata(
  trustedSessionSource: TrustedSessionSource,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    autoDeleteTrigger: "startup-armed",
    trustedSessionSource,
    ...extra,
  };
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

async function reportStartupAutoDeleteBlocked(
  client: SessionJanitorClient,
  result: Extract<StartupAutoDeleteConfigResult, { kind: "blocked" }>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const level = result.errors.length > 0 ? "error" : "warn";
  const message = "Session janitor startup auto delete blocked";

  if (client.app?.log) {
    try {
      await logToApp(client, level, message, {
        trigger: "startup",
        ...extra,
        errors: result.errors,
        warnings: result.warnings,
      });
      return;
    } catch (error) {
      console.warn(
        `${message}: ${formatMessages(result)}\n` +
          `Also failed to log startup auto delete block: ${formatUnknownError(error)}`,
      );
      return;
    }
  }

  console.warn(`${message}: ${formatMessages(result)}`);
}

async function logToApp(
  client: SessionJanitorClient,
  level: LogLevel,
  message: string,
  extra: Record<string, unknown>,
): Promise<void> {
  if (!client.app?.log) {
    throw new Error("client.app.log is unavailable");
  }

  const logged = unwrapResponse(
    await client.app.log({
      body: {
        service: serviceName,
        level,
        message,
        extra,
      },
    }),
    "client.app.log",
  );
  if (logged !== true) {
    throw new Error("client.app.log returned false");
  }
}

async function reportStartupError(
  kind: StartupRunKind,
  client: SessionJanitorClient,
  error: unknown,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const formatted = formatUnknownError(error);
  if (client.app?.log) {
    try {
      await logToApp(
        client,
        "error",
        `Session janitor startup ${kind} failed unexpectedly`,
        {
          trigger: "startup",
          ...extra,
          error: formatted,
        },
      );
      return;
    } catch (error) {
      console.warn(
        `Session janitor startup ${kind} failed unexpectedly: ${formatted}\n` +
          `Also failed to log startup ${kind} error: ${formatUnknownError(error)}`,
      );
      return;
    }
  }

  console.warn(
    `Session janitor startup ${kind} failed unexpectedly: ${formatted}`,
  );
}

function formatMessages(result: {
  errors: string[];
  warnings: string[];
}): string {
  return [...result.errors, ...result.warnings].join("\n");
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
