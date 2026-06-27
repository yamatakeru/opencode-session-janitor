import type { Session } from "@opencode-ai/sdk";

import { resolveConfig } from "./config.js";
import type { SessionJanitorConfig } from "./config.js";
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
} from "./janitor-session-client.js";

export type { SessionJanitorClient } from "./janitor-session-client.js";

const serviceName = "opencode-session-janitor";

type LogResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };

export type RunSessionJanitorInput = {
  client: SessionJanitorClient;
  pluginOptions?: unknown;
  toolArgs?: Partial<SessionJanitorConfig>;
  currentSessionID?: string;
  trigger?: "manual";
  now?: number;
  abortSignal?: AbortSignal;
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
  toolArgs,
  currentSessionID,
  trigger = "manual",
  now = Date.now(),
  abortSignal,
}: RunSessionJanitorInput): Promise<RunSessionJanitorResult> {
  const validation = resolveConfig(pluginOptions, toolArgs);
  if (!validation.ok) {
    const metadata = {
      ok: false,
      trigger,
      mode: "validation-error",
      errors: validation.errors,
      warnings: validation.warnings,
    };
    return finalizeWithLog(
      client,
      "warn",
      "Session janitor validation failed",
      {
        title: "Session janitor validation failed",
        output: renderValidationError(validation.errors, validation.warnings),
        metadata,
      },
    );
  }

  const config = validation.config;
  const mode = config.dryRun ? "dry-run" : "delete";
  const warnings = [...validation.warnings];
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
    };
    return finalizeWithLog(
      client,
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
        warnings,
      };
      return finalizeWithLog(client, "error", "Session janitor guard failed", {
        title: "Session janitor guard failed",
        output: renderGuardError(message, warnings),
        metadata,
      });
    }

    warnings.push(message);
  }

  if (abortSignal?.aborted) {
    return renderCancelledResult(client, trigger, warnings, "before-list");
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
      warnings,
    };
    return finalizeWithLog(
      client,
      "error",
      "Session janitor failed to list sessions",
      {
        title: "Session janitor failed",
        output: renderListError(message, warnings),
        metadata,
      },
    );
  }

  if (abortSignal?.aborted) {
    return renderCancelledResult(client, trigger, warnings, "after-list");
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
      warnings,
    };
    return finalizeWithLog(
      client,
      "error",
      "Session janitor failed to evaluate sessions",
      {
        title: "Session janitor failed",
        output: renderEvaluationError(message, warnings),
        metadata,
      },
    );
  }

  if (abortSignal?.aborted) {
    return renderCancelledResult(client, trigger, warnings, "after-evaluation");
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
    });
    return finalizeWithLog(
      client,
      "info",
      "Session janitor dry-run completed",
      {
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
      },
    );
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
  });

  return finalizeWithLog(
    client,
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
  trigger: "manual";
  mode: string;
  config: SessionJanitorConfig;
  warnings: string[];
  evaluation: EvaluationResult;
  deleted: DeleteSuccess[];
  failed: DeleteFailure[];
  deleteAborted?: string;
}): Record<string, unknown> {
  return {
    ok: input.ok,
    trigger: input.trigger,
    mode: input.mode,
    config: input.config,
    warnings: input.warnings,
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
  trigger: "manual",
  warnings: string[],
  stage: "before-list" | "after-list" | "after-evaluation",
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
      warnings,
    },
  });
}

async function finalizeWithLog(
  client: SessionJanitorClient,
  level: LogLevel,
  message: string,
  result: RunSessionJanitorResult,
): Promise<RunSessionJanitorResult> {
  const logging = await safeLog(client, level, message, result.metadata);

  return {
    title: result.title,
    output: appendLoggingWarning(result.output, logging),
    metadata: {
      ...result.metadata,
      logging,
    },
  };
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
