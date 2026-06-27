import type { Session } from "@opencode-ai/sdk";

import { resolveConfig } from "./config.js";
import type { SessionJanitorConfig } from "./config.js";
import type { EvaluationResult, SessionCandidate } from "./evaluate.js";
import { evaluateSessions } from "./evaluate.js";

const serviceName = "opencode-session-janitor";

type ResponseFields<T> =
  | {
      data: T;
      error?: undefined;
    }
  | {
      data?: undefined;
      error: unknown;
    };

type MaybeResponseFields<T> = T | ResponseFields<T>;

type LogResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };

export type SessionJanitorClient = {
  session: {
    list(): Promise<MaybeResponseFields<Session[]>>;
    delete(input: {
      path: { id: string };
    }): Promise<MaybeResponseFields<boolean>>;
  };
  app?: {
    log(input: {
      body: {
        service: string;
        level: "debug" | "info" | "error" | "warn";
        message: string;
        extra?: Record<string, unknown>;
      };
    }): Promise<MaybeResponseFields<boolean>>;
  };
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
    failed.length > 0 ? "error" : wasAborted ? "warn" : "info",
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

async function listSessions(client: SessionJanitorClient): Promise<Session[]> {
  const sessions = unwrapResponse(
    await client.session.list(),
    "client.session.list()",
  );
  if (!Array.isArray(sessions)) {
    throw new Error("client.session.list() returned a non-array response");
  }
  return sessions;
}

async function deleteSession(
  client: SessionJanitorClient,
  sessionID: string,
): Promise<void> {
  if (!isNonEmptyString(sessionID)) {
    throw new Error("Refusing to delete session without a non-empty string id");
  }

  const response = await client.session.delete({ path: { id: sessionID } });
  const deleted = unwrapDeleteResponse(response, sessionID);
  if (deleted !== true) {
    throw new RecoverableDeleteFailureError("delete returned false");
  }
}

function unwrapDeleteResponse(response: unknown, sessionID: string): boolean {
  const label = `client.session.delete(${sessionID})`;
  if (
    isRecord(response) &&
    "error" in response &&
    response.error !== undefined
  ) {
    throw new RecoverableDeleteFailureError(
      `${label} failed: ${formatUnknownError(response.error)}`,
    );
  }
  if (isRecord(response) && "data" in response) {
    if (response.data === undefined) {
      throw new UnexpectedDeleteResponseError(`${label} returned no data`);
    }
    if (typeof response.data !== "boolean") {
      throw new UnexpectedDeleteResponseError(
        `${label} returned non-boolean data: ${formatUnknownError(response.data)}`,
      );
    }
    return response.data;
  }
  if (typeof response !== "boolean") {
    throw new UnexpectedDeleteResponseError(
      `${label} returned unexpected response shape: ${formatUnknownError(response)}`,
    );
  }
  return response;
}

function unwrapResponse<T>(response: MaybeResponseFields<T>, label: string): T {
  if (
    isRecord(response) &&
    "error" in response &&
    response.error !== undefined
  ) {
    throw new Error(`${label} failed: ${formatUnknownError(response.error)}`);
  }
  if (isRecord(response) && "data" in response) {
    if (response.data === undefined) {
      throw new Error(`${label} returned no data`);
    }
    return response.data as T;
  }
  return response as T;
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
  level: "debug" | "info" | "error" | "warn",
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
  level: "debug" | "info" | "error" | "warn",
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

function renderValidationError(errors: string[], warnings: string[]): string {
  return [
    "opencode-session-janitor",
    "Mode: validation-error",
    "No sessions were listed or deleted because config validation failed.",
    "",
    "Errors:",
    ...errors.map((error) => `- ${error}`),
    ...renderWarnings(warnings),
  ].join("\n");
}

function renderGuardError(error: string, warnings: string[]): string {
  return [
    "opencode-session-janitor",
    "Mode: guard-error",
    "No sessions were listed or deleted because a safety guard failed.",
    "",
    `Error: ${error}`,
    ...renderWarnings(warnings),
  ].join("\n");
}

function renderListError(error: string, warnings: string[]): string {
  return [
    "opencode-session-janitor",
    "Mode: list-error",
    "No sessions were deleted because session listing failed.",
    "",
    `Error: ${error}`,
    ...renderWarnings(warnings),
  ].join("\n");
}

function renderEvaluationError(error: string, warnings: string[]): string {
  return [
    "opencode-session-janitor",
    "Mode: evaluation-error",
    "No sessions were deleted because session evaluation failed.",
    "",
    `Error: ${error}`,
    ...renderWarnings(warnings),
  ].join("\n");
}

function renderCancelled(
  error: string,
  warnings: string[],
  stage: "before-list" | "after-list" | "after-evaluation",
): string {
  return [
    "opencode-session-janitor",
    "Mode: cancelled",
    renderCancelledDetail(stage),
    "",
    `Error: ${error}`,
    ...renderWarnings(warnings),
  ].join("\n");
}

function renderCancelledDetail(
  stage: "before-list" | "after-list" | "after-evaluation",
): string {
  switch (stage) {
    case "before-list":
      return "No sessions were listed or deleted because the run was cancelled.";
    case "after-list":
      return "Sessions were listed, but no sessions were deleted because the run was cancelled.";
    case "after-evaluation":
      return "Sessions were listed and evaluated, but no sessions were deleted because the run was cancelled.";
  }
}

function renderResult(input: {
  trigger: "manual";
  mode: string;
  config: SessionJanitorConfig;
  warnings: string[];
  evaluation: EvaluationResult;
  deleted: DeleteSuccess[];
  failed: DeleteFailure[];
  deleteAborted?: string;
}): string {
  const lines = [
    "opencode-session-janitor",
    `Mode: ${input.mode}`,
    `Trigger: ${input.trigger}`,
    `Retention days: ${input.config.retentionDays}`,
    `Include shared: ${input.config.includeShared}`,
    `Exclude current session: ${input.config.excludeCurrentSession}`,
    `Min sessions to keep: ${input.config.minSessionsToKeep}`,
    `Max delete count: ${input.config.maxDeleteCount}`,
    `Total sessions: ${input.evaluation.totalSessions}`,
    `Candidates: ${input.evaluation.candidates.length}`,
    `Skipped: ${input.evaluation.skipped.length}`,
    `Deleted: ${input.deleted.length}`,
    `Failed: ${input.failed.length}`,
    `Max delete count applied: ${input.evaluation.maxDeleteCountApplied ? "yes" : "no"}`,
  ];

  if (input.mode === "dry-run") {
    lines.push("", "Dry-run only: no sessions were deleted.");
  }

  lines.push(...renderWarnings(input.warnings));
  lines.push("", "Candidates:");
  lines.push(...renderCandidates(input.evaluation.candidates));
  lines.push("", "Skipped counts by reason:");
  lines.push(...renderSkippedCounts(input.evaluation.skippedCounts));
  lines.push("", "Skipped sessions:");
  lines.push(...renderSkippedSessions(input.evaluation.skipped));

  if (input.deleted.length > 0) {
    lines.push("", "Deleted sessions:");
    lines.push(
      ...input.deleted.map(
        (session) => `- ${session.id}; title=${quote(session.title)}`,
      ),
    );
  }

  if (input.failed.length > 0) {
    lines.push("", "Failed deletions:");
    lines.push(
      ...input.failed.map(
        (session) =>
          `- ${session.id}; title=${quote(session.title)}; error=${quote(session.error)}`,
      ),
    );
  }

  if (input.deleteAborted !== undefined) {
    lines.push("", `Delete aborted: ${input.deleteAborted}`);
  }

  return lines.join("\n");
}

function renderWarnings(warnings: string[]): string[] {
  if (warnings.length === 0) {
    return [];
  }
  return ["", "Warnings:", ...warnings.map((warning) => `- ${warning}`)];
}

function appendLoggingWarning(output: string, logging: LogResult): string {
  if (logging.ok) {
    return output;
  }

  return `${output}\n\nLogging warning: ${logging.error}`;
}

function renderCandidates(candidates: SessionCandidate[]): string[] {
  if (candidates.length === 0) {
    return ["- none"];
  }
  return candidates.map(
    (session) =>
      `- ${session.id}; title=${quote(session.title)}; directory=${quote(session.directory)}; projectID=${session.projectID}; updated=${session.updatedISO}; ageDays=${formatAge(session.ageDays)}; shared=${session.shared ? "yes" : "no"}; reason=${session.reason}`,
  );
}

function renderSkippedCounts(
  counts: EvaluationResult["skippedCounts"],
): string[] {
  return Object.entries(counts).map(
    ([reason, count]) => `- ${reason}: ${count}`,
  );
}

function renderSkippedSessions(skipped: EvaluationResult["skipped"]): string[] {
  if (skipped.length === 0) {
    return ["- none"];
  }
  return skipped.map((session) => {
    const fields = [
      `- ${session.id}`,
      `title=${quote(session.title)}`,
      session.directory === undefined
        ? undefined
        : `directory=${quote(session.directory)}`,
      session.projectID === undefined
        ? undefined
        : `projectID=${session.projectID}`,
      session.updatedISO === undefined
        ? undefined
        : `updated=${session.updatedISO}`,
      session.ageDays === undefined
        ? undefined
        : `ageDays=${formatAge(session.ageDays)}`,
      session.shared === undefined
        ? undefined
        : `shared=${session.shared ? "yes" : "no"}`,
      `reason=${session.reason}`,
    ].filter((field): field is string => field !== undefined);

    return fields.join("; ");
  });
}

function formatAge(ageDays: number): string {
  return ageDays.toFixed(2);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (isRecord(error) && typeof error.message === "string") {
    const context = formatRecordContext(error);
    return context.length > 0 ? `${error.message} (${context})` : error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined) {
    return "undefined";
  }
  if (typeof error === "symbol" || typeof error === "function") {
    return `Unserializable error value (${typeof error}): ${String(error)}`;
  }

  try {
    const serialized = JSON.stringify(error);
    return serialized === undefined
      ? `Unserializable error value (${typeof error}): ${String(error)}`
      : serialized;
  } catch (formatError) {
    const formatterMessage =
      formatError instanceof Error ? formatError.message : String(formatError);
    return `Unserializable error value (${Object.prototype.toString.call(error)}); formatter failed: ${formatterMessage}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatRecordContext(record: Record<string, unknown>): string {
  const preferredKeys = [
    "name",
    "code",
    "status",
    "statusCode",
    "requestID",
    "requestId",
  ];
  const fields = preferredKeys.flatMap((key) => {
    if (!(key in record)) {
      return [];
    }

    const value = record[key];
    return isScalar(value) ? [`${key}=${String(value)}`] : [];
  });

  return fields.join(", ");
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

class RecoverableDeleteFailureError extends Error {
  override name = "RecoverableDeleteFailureError";
}

class UnexpectedDeleteResponseError extends Error {
  override name = "UnexpectedDeleteResponseError";
}
