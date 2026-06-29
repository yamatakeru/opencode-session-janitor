import type { Session } from "@opencode-ai/sdk";

import { getCleanupOptions, resolveConfigFromSources } from "./config.js";
import type {
  ResolvedSessionJanitorConfig,
  SessionJanitorConfig,
  SessionJanitorTrigger,
} from "./config.js";
import { loadSessionJanitorConfigFile } from "./config-file.js";
import type { ConfigFileLoadResult } from "./config-file.js";
import type { EvaluationResult } from "./evaluate.js";
import { evaluateSessions } from "./evaluate.js";
import {
  appendLoggingWarning,
  renderCancelled,
  renderEvaluationError,
  renderGuardError,
  renderListError,
  renderResult,
  renderValidationError,
} from "./janitor-output.js";
import {
  deleteSession,
  formatUnknownError,
  listSessions,
  RecoverableDeleteFailureError,
  unwrapResponse,
} from "./janitor-session-client.js";
import type {
  LogLevel,
  SessionJanitorClient,
  TuiToastVariant,
} from "./janitor-session-client.js";

export type { SessionJanitorClient } from "./janitor-session-client.js";

const serviceName = "opencode-session-janitor";
const autoDeleteRequiresAllowWarning =
  "dryRun:false ignored because startup auto delete requires allowAutoDelete:true.";
const autoDeleteRequiresCurrentSessionProtectionWarning =
  "dryRun:false ignored because startup auto delete requires excludeCurrentSession:true.";
const autoDeleteSharedUnsupportedWarning =
  "dryRun:false ignored because startup auto delete does not support includeShared:true.";
const nonStartupDryRunWarning =
  "dryRun:false ignored because automatic deletion is only supported for trigger:startup.";

export type LogResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };

export type RunSessionJanitorInput = {
  client: SessionJanitorClient;
  pluginOptions?: unknown;
  configFileBaseDir?: string;
  currentSessionID?: string;
  trigger?: SessionJanitorTrigger;
  now?: number;
  abortSignal?: AbortSignal;
  forceDryRun?: boolean;
  suppressTuiToast?: boolean;
};

export type DeleteSuccess = {
  id: string;
  title: string;
};

export type DeleteFailure = {
  id: string;
  title: string;
  error: string;
};

export type RunSessionJanitorResult = {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
};

export async function runSessionJanitor({
  client,
  pluginOptions,
  configFileBaseDir,
  currentSessionID,
  trigger = "startup",
  now = Date.now(),
  abortSignal,
  forceDryRun = false,
  suppressTuiToast = false,
}: RunSessionJanitorInput): Promise<RunSessionJanitorResult> {
  const finalizeRun = (
    level: LogLevel,
    message: string,
    result: RunSessionJanitorResult,
  ) => finalizeWithLog(client, level, message, result, { suppressTuiToast });

  const configFile = await loadSessionJanitorConfigFile({
    baseDir: configFileBaseDir,
    pluginOptions,
  });
  const configFileMetadata = buildConfigFileMetadata(configFile);
  const pluginCleanupOptions = getCleanupOptions(pluginOptions);
  const invalidConfigNotificationConfig = {
    notifyTui: getNotifyTuiPreference(configFile.options, pluginCleanupOptions),
  };
  const validation =
    configFile.errors.length > 0
      ? {
          ok: false as const,
          errors: configFile.errors,
          warnings: [],
        }
      : resolveConfigFromSources(configFile.options, pluginCleanupOptions);
  if (!validation.ok) {
    const metadata = {
      ok: false,
      trigger,
      mode: "validation-error",
      errors: validation.errors,
      warnings: validation.warnings,
      config: invalidConfigNotificationConfig,
      configFile: configFileMetadata,
    };
    return finalizeRun("warn", "Session janitor validation failed", {
      title: "Session janitor validation failed",
      output: renderValidationError(validation.errors, validation.warnings),
      metadata,
    });
  }

  const warnings = [...validation.warnings];
  const config = forceDryRun
    ? applyForcedDryRun(validation.config, warnings)
    : applyAutoDeleteGate(validation.config, warnings, trigger);
  const mode = config.dryRun ? "dry-run" : "delete";
  const verifiedCurrentSessionID = isNonEmptyString(currentSessionID)
    ? currentSessionID
    : undefined;

  if (!config.dryRun && warnings.length > 0) {
    const errors = warnings.map(
      (warning) =>
        `Refusing delete because configuration was not fully recognized: ${warning}`,
    );
    const metadata = {
      ok: false,
      trigger,
      mode: "validation-error",
      errors,
      warnings,
      config,
      configFile: configFileMetadata,
    };
    return finalizeRun(
      "error",
      "Session janitor delete blocked by config warnings",
      {
        title: "Session janitor validation failed",
        output: renderValidationError(errors, warnings),
        metadata,
      },
    );
  }

  if (config.excludeCurrentSession && verifiedCurrentSessionID === undefined) {
    const message =
      "Current session ID is unavailable, so current-session protection cannot be verified.";

    if (!config.dryRun) {
      const metadata = {
        ok: false,
        trigger,
        mode,
        error: message,
        config,
        warnings,
        configFile: configFileMetadata,
      };
      return finalizeRun("error", "Session janitor guard failed", {
        title: "Session janitor guard failed",
        output: renderGuardError(message, warnings),
        metadata,
      });
    }

    warnings.push(message);
  }

  if (abortSignal?.aborted) {
    return renderCancelledResult(
      client,
      trigger,
      warnings,
      "before-list",
      config,
      configFileMetadata,
    );
  }

  let sessions: Session[];

  try {
    sessions = await listSessions(client);
  } catch (error) {
    const message = formatUnknownError(error);
    const metadata = {
      ok: false,
      trigger,
      mode,
      error: message,
      config,
      warnings,
      configFile: configFileMetadata,
    };
    return finalizeRun("error", "Session janitor failed to list sessions", {
      title: "Session janitor failed",
      output: renderListError(message, warnings),
      metadata,
    });
  }

  if (abortSignal?.aborted) {
    return renderCancelledResult(
      client,
      trigger,
      warnings,
      "after-list",
      config,
      configFileMetadata,
    );
  }

  let evaluation: EvaluationResult;
  try {
    evaluation = evaluateSessions({
      sessions,
      config,
      currentSessionID: verifiedCurrentSessionID,
      now,
    });
  } catch (error) {
    const message = formatUnknownError(error);
    const metadata = {
      ok: false,
      trigger,
      mode,
      error: message,
      config,
      warnings,
      configFile: configFileMetadata,
    };
    return finalizeRun("error", "Session janitor failed to evaluate sessions", {
      title: "Session janitor failed",
      output: renderEvaluationError(message, warnings),
      metadata,
    });
  }

  if (abortSignal?.aborted) {
    return renderCancelledResult(
      client,
      trigger,
      warnings,
      "after-evaluation",
      config,
      configFileMetadata,
    );
  }

  if (config.dryRun) {
    const metadata = buildMetadata({
      ok: true,
      trigger,
      mode,
      config,
      warnings,
      evaluation,
      deleted: [],
      failed: [],
      configFile: configFileMetadata,
    });
    return finalizeRun("info", "Session janitor dry-run completed", {
      title: "Session janitor dry-run",
      output: renderResult({
        trigger,
        mode,
        config,
        warnings,
        evaluation,
        deleted: [],
        failed: [],
      }),
      metadata,
    });
  }

  const deleted: DeleteSuccess[] = [];
  const failed: DeleteFailure[] = [];
  let deleteAborted: string | undefined;

  for (const candidate of evaluation.candidates) {
    if (abortSignal?.aborted) {
      deleteAborted = "Session janitor was cancelled by the user.";
      break;
    }

    try {
      await deleteSession(client, candidate.id);
      deleted.push({ id: candidate.id, title: candidate.title });
    } catch (error) {
      const formatted = formatUnknownError(error);
      failed.push({
        id: candidate.id,
        title: candidate.title,
        error: formatted,
      });

      if (!(error instanceof RecoverableDeleteFailureError)) {
        deleteAborted = formatted;
        break;
      }
    }

    if (abortSignal?.aborted) {
      deleteAborted = "Session janitor was cancelled by the user.";
      break;
    }
  }

  const wasAborted = deleteAborted !== undefined;
  const metadata = buildMetadata({
    ok: failed.length === 0 && !wasAborted,
    trigger,
    mode,
    config,
    warnings,
    evaluation,
    deleted,
    failed,
    deleteAborted,
    configFile: configFileMetadata,
  });

  return finalizeRun(
    getDeleteLogLevel(failed, wasAborted),
    wasAborted
      ? "Session janitor delete aborted"
      : "Session janitor delete completed",
    {
      title: "Session janitor delete",
      output: renderResult({
        trigger,
        mode,
        config,
        warnings,
        evaluation,
        deleted,
        failed,
        deleteAborted,
      }),
      metadata,
    },
  );
}

function applyAutoDeleteGate(
  config: ResolvedSessionJanitorConfig,
  warnings: string[],
  trigger: SessionJanitorTrigger,
): ResolvedSessionJanitorConfig {
  if (config.dryRun) {
    return config;
  }

  const gateWarnings = getAutoDeleteGateWarnings(config, trigger);
  if (gateWarnings.length === 0) {
    return config;
  }

  warnings.push(...gateWarnings);
  return { ...config, dryRun: true };
}

function applyForcedDryRun(
  config: ResolvedSessionJanitorConfig,
  warnings: string[],
): ResolvedSessionJanitorConfig {
  if (config.dryRun) {
    return config;
  }

  warnings.push("dryRun:false ignored because this run was forced to dry-run.");
  return { ...config, dryRun: true };
}

function getAutoDeleteGateWarnings(
  config: ResolvedSessionJanitorConfig,
  trigger: SessionJanitorTrigger,
): string[] {
  const warnings: string[] = [];

  if (trigger !== "startup") {
    warnings.push(nonStartupDryRunWarning);
  }
  if (!config.allowAutoDelete) {
    warnings.push(autoDeleteRequiresAllowWarning);
  }
  if (!config.excludeCurrentSession) {
    warnings.push(autoDeleteRequiresCurrentSessionProtectionWarning);
  }
  if (config.includeShared) {
    warnings.push(autoDeleteSharedUnsupportedWarning);
  }

  return warnings;
}

function buildMetadata(input: {
  ok: boolean;
  trigger: SessionJanitorTrigger;
  mode: string;
  config: SessionJanitorConfig;
  warnings: string[];
  evaluation: EvaluationResult;
  deleted: DeleteSuccess[];
  failed: DeleteFailure[];
  deleteAborted?: string;
  configFile: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ok: input.ok,
    trigger: input.trigger,
    mode: input.mode,
    config: input.config,
    warnings: input.warnings,
    configFile: input.configFile,
    totalSessions: input.evaluation.totalSessions,
    candidates: input.evaluation.candidates,
    candidateCount: input.evaluation.candidates.length,
    skippedCounts: input.evaluation.skippedCounts,
    skippedCount: input.evaluation.skipped.length,
    deleted: input.deleted,
    deletedCount: input.deleted.length,
    failed: input.failed,
    failedCount: input.failed.length,
    deleteAborted: input.deleteAborted,
    maxDeleteCountApplied: input.evaluation.maxDeleteCountApplied,
  };
}

function renderCancelledResult(
  client: SessionJanitorClient,
  trigger: SessionJanitorTrigger,
  warnings: string[],
  stage: "before-list" | "after-list" | "after-evaluation",
  config: SessionJanitorConfig,
  configFile: Record<string, unknown>,
): Promise<RunSessionJanitorResult> {
  const message = "Session janitor was cancelled by the user.";
  return finalizeWithLog(client, "warn", "Session janitor cancelled", {
    title: "Session janitor cancelled",
    output: renderCancelled(message, warnings, stage),
    metadata: {
      ok: false,
      trigger,
      mode: "cancelled",
      cancellationStage: stage,
      error: message,
      config,
      warnings,
      configFile,
    },
  });
}

function buildConfigFileMetadata(
  configFile: ConfigFileLoadResult,
): Record<string, unknown> {
  return {
    path: configFile.path,
    loaded: configFile.loaded,
    errors: configFile.errors,
  };
}

function getNotifyTuiPreference(
  configFileOptions: unknown,
  pluginOptions: unknown,
): boolean {
  const configFileValue = readNotifyTuiPreference(configFileOptions);
  const pluginValue = readNotifyTuiPreference(pluginOptions);
  return pluginValue ?? configFileValue ?? true;
}

function readNotifyTuiPreference(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const notifyTui = (value as { notifyTui?: unknown }).notifyTui;
  return typeof notifyTui === "boolean" ? notifyTui : undefined;
}

async function finalizeWithLog(
  client: SessionJanitorClient,
  level: LogLevel,
  message: string,
  result: RunSessionJanitorResult,
  options: { suppressTuiToast?: boolean } = {},
): Promise<RunSessionJanitorResult> {
  const tuiNotification = options.suppressTuiToast
    ? ({ ok: false, error: "TUI toast suppressed" } as const)
    : await safeShowTuiToast(client, result.metadata);
  const metadata = { ...result.metadata, tuiNotification };
  const logging = await safeLog(client, level, message, metadata);

  return {
    title: result.title,
    output: appendLoggingWarning(result.output, logging),
    metadata: {
      ...metadata,
      logging,
    },
  };
}

export async function safeShowTuiToast(
  client: SessionJanitorClient,
  metadata: Record<string, unknown>,
): Promise<LogResult> {
  if (!shouldNotifyTui(metadata)) {
    return { ok: false, error: "TUI notifications are disabled" };
  }
  if (!client.tui?.showToast) {
    return { ok: false, error: "client.tui.showToast is unavailable" };
  }

  try {
    const response = await client.tui.showToast({
      body: {
        title: "Session Janitor",
        message: buildTuiToastMessage(metadata),
        variant: getTuiToastVariant(metadata),
        duration: 10000,
      },
    });
    if (isErrorResponse(response)) {
      return {
        ok: false,
        error: `client.tui.showToast failed: ${formatUnknownError(response.error)}`,
      };
    }
    if (isDataResponse(response) && response.data === false) {
      return { ok: false, error: "client.tui.showToast returned false" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `client.tui.showToast failed: ${formatUnknownError(error)}`,
    };
  }
}

export function shouldNotifyTui(metadata: Record<string, unknown>): boolean {
  const config = metadata.config;
  if (typeof config !== "object" || config === null) {
    return false;
  }

  return (config as { notifyTui?: unknown }).notifyTui === true;
}

function buildTuiToastMessage(metadata: Record<string, unknown>): string {
  const mode = typeof metadata.mode === "string" ? metadata.mode : "unknown";
  if (metadata.ok !== true) {
    return `Run failed (${mode}); check the app log for details.`;
  }

  const candidates = getCount(metadata.candidateCount);
  const deleted = getCount(metadata.deletedCount);
  const failed = getCount(metadata.failedCount);
  if (mode === "delete") {
    return `Delete completed: ${deleted} deleted, ${failed} failed, ${candidates} candidates.`;
  }

  return `Dry-run completed: ${candidates} cleanup candidates. No sessions were deleted.`;
}

function getTuiToastVariant(
  metadata: Record<string, unknown>,
): TuiToastVariant {
  if (metadata.ok !== true) {
    return "error";
  }
  if (metadata.mode === "delete") {
    return getCount(metadata.deletedCount) > 0 ? "warning" : "success";
  }
  return getCount(metadata.candidateCount) > 0 ? "info" : "success";
}

function getCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isErrorResponse(
  value: unknown,
): value is { error: unknown; data?: undefined } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    value.error !== undefined
  );
}

function isDataResponse(value: unknown): value is { data: unknown } {
  return typeof value === "object" && value !== null && "data" in value;
}

async function safeLog(
  client: SessionJanitorClient,
  level: LogLevel,
  message: string,
  extra: Record<string, unknown>,
): Promise<LogResult> {
  if (!client.app?.log) {
    return { ok: false, error: "client.app.log is unavailable" };
  }

  try {
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
      return { ok: false, error: "client.app.log returned false" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `client.app.log failed: ${formatUnknownError(error)}`,
    };
  }
}

function getDeleteLogLevel(
  failed: DeleteFailure[],
  wasAborted: boolean,
): LogLevel {
  if (failed.length > 0) {
    return "error";
  }
  if (wasAborted) {
    return "warn";
  }
  return "info";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
