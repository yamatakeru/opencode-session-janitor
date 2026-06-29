import { appendLoggingWarning } from "./janitor-output.js";
import {
  formatUnknownError,
  unwrapResponse,
} from "./janitor-session-client.js";
import type {
  LogLevel,
  SessionJanitorClient,
  TuiToastVariant,
} from "./janitor-session-client.js";

const serviceName = "opencode-session-janitor";

type FinalizableRunResult = {
  title: string;
  output: string;
  metadata: Record<string, unknown>;
};

export type LogResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };

export async function finalizeWithLog(
  client: SessionJanitorClient,
  level: LogLevel,
  message: string,
  result: FinalizableRunResult,
  options: { suppressTuiToast?: boolean } = {},
): Promise<FinalizableRunResult> {
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
