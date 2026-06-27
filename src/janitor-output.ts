import type { SessionJanitorConfig } from "./config.js";
import type { EvaluationResult, SessionCandidate } from "./evaluate.js";

type RenderedDeleteSuccess = {
  id: string;
  title: string;
};

type RenderedDeleteFailure = RenderedDeleteSuccess & {
  error: string;
};

type LogResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };

type CancellationStage = "before-list" | "after-list" | "after-evaluation";

export function renderValidationError(
  errors: string[],
  warnings: string[],
): string {
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

export function renderGuardError(error: string, warnings: string[]): string {
  return [
    "opencode-session-janitor",
    "Mode: guard-error",
    "No sessions were listed or deleted because a safety guard failed.",
    "",
    `Error: ${error}`,
    ...renderWarnings(warnings),
  ].join("\n");
}

export function renderListError(error: string, warnings: string[]): string {
  return [
    "opencode-session-janitor",
    "Mode: list-error",
    "No sessions were deleted because session listing failed.",
    "",
    `Error: ${error}`,
    ...renderWarnings(warnings),
  ].join("\n");
}

export function renderEvaluationError(
  error: string,
  warnings: string[],
): string {
  return [
    "opencode-session-janitor",
    "Mode: evaluation-error",
    "No sessions were deleted because session evaluation failed.",
    "",
    `Error: ${error}`,
    ...renderWarnings(warnings),
  ].join("\n");
}

export function renderCancelled(
  error: string,
  warnings: string[],
  stage: CancellationStage,
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

export function renderResult(input: {
  trigger: "manual";
  mode: string;
  config: SessionJanitorConfig;
  warnings: string[];
  evaluation: EvaluationResult;
  deleted: RenderedDeleteSuccess[];
  failed: RenderedDeleteFailure[];
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

export function appendLoggingWarning(
  output: string,
  logging: LogResult,
): string {
  if (logging.ok) {
    return output;
  }

  return `${output}\n\nLogging warning: ${logging.error}`;
}

function renderCancelledDetail(stage: CancellationStage): string {
  switch (stage) {
    case "before-list":
      return "No sessions were listed or deleted because the run was cancelled.";
    case "after-list":
      return "Sessions were listed, but no sessions were deleted because the run was cancelled.";
    case "after-evaluation":
      return "Sessions were listed and evaluated, but no sessions were deleted because the run was cancelled.";
  }
}

function renderWarnings(warnings: string[]): string[] {
  if (warnings.length === 0) {
    return [];
  }
  return ["", "Warnings:", ...warnings.map((warning) => `- ${warning}`)];
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
