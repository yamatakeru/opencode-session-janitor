import type { Session } from "@opencode-ai/sdk";

import { getCleanupOptions, resolveConfigFromOptionSources } from "./config.js";
import type {
  ConfigValidationResult,
  SessionJanitorConfig,
  SessionJanitorTrigger,
} from "./config.js";
import { loadSessionJanitorConfigFile } from "./config-file.js";
import type { ConfigFileLoadResult } from "./config-file.js";
import type { EvaluationResult } from "./evaluate.js";
import { evaluateSessions } from "./evaluate.js";
import {
  renderCancelled,
  renderEvaluationError,
  renderGuardError,
  renderListError,
  renderResult,
  renderValidationError,
} from "./janitor-output.js";
import { finalizeWithLog } from "./janitor-notifier.js";
import {
  applyAutoDeleteGate,
  applyForcedDryRun,
  getDeleteBlockedByWarningsErrors,
} from "./janitor-policy.js";
import {
  deleteSession,
  formatUnknownError,
  listSessions,
  RecoverableDeleteFailureError,
} from "./janitor-session-client.js";
import type {
  LogLevel,
  SessionJanitorClient,
} from "./janitor-session-client.js";

export type { SessionJanitorClient } from "./janitor-session-client.js";
export { safeShowTuiToast, shouldNotifyTui } from "./janitor-notifier.js";
export type { LogResult } from "./janitor-notifier.js";

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
  const validation = resolveLoadedConfig(configFile, pluginCleanupOptions);
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

  const warnings = validation.warnings;
  const config = forceDryRun
    ? applyForcedDryRun(validation.config, warnings)
    : applyAutoDeleteGate(validation.config, warnings, trigger);
  const mode = config.dryRun ? "dry-run" : "delete";
  const verifiedCurrentSessionID = isNonEmptyString(currentSessionID)
    ? currentSessionID
    : undefined;

  if (!config.dryRun && warnings.length > 0) {
    const errors = getDeleteBlockedByWarningsErrors(warnings);
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

function resolveLoadedConfig(
  configFile: ConfigFileLoadResult,
  pluginCleanupOptions: unknown,
): ConfigValidationResult {
  if (configFile.errors.length > 0) {
    return {
      ok: false,
      errors: configFile.errors,
      warnings: configFile.warnings,
    };
  }

  const validation = resolveConfigFromOptionSources(
    configFile.optionSources,
    pluginCleanupOptions,
  );
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      warnings: [...configFile.warnings, ...validation.warnings],
    };
  }

  return {
    ok: true,
    config: validation.config,
    warnings: [...configFile.warnings, ...validation.warnings],
  };
}

function buildConfigFileMetadata(
  configFile: ConfigFileLoadResult,
): Record<string, unknown> {
  return {
    path: configFile.path,
    loaded: configFile.loaded,
    files: configFile.files,
    warnings: configFile.warnings,
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
