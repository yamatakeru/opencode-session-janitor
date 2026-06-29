import type { StartupAutoDeleteConfigResult } from "./plugin-startup-config.js";
import { safeShowTuiToast, shouldNotifyTui } from "./janitor-notifier.js";
import type { RunSessionJanitorResult } from "./janitor.js";
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

export type StartupLoggingResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };
export type StartupRunKind = "dry-run" | "auto delete";

export function scheduleDelayedStartupToast(
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

export function reportStartupResultProblems(
  kind: StartupRunKind,
  result: RunSessionJanitorResult,
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

export async function reportStartupAutoDeleteBlocked(
  client: SessionJanitorClient,
  result: Extract<StartupAutoDeleteConfigResult, { kind: "blocked" }>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const level = result.errors.length > 0 ? "error" : "warn";
  const message = "Session janitor startup auto delete blocked";

  if (client.app?.log) {
    try {
      await logToApp(client, level, message, {
        ...extra,
        trigger: "startup",
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

export async function reportStartupError(
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
          ...extra,
          trigger: "startup",
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

export function isStartupLoggingFailure(
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

function formatMessages(result: {
  errors: string[];
  warnings: string[];
}): string {
  return [...result.errors, ...result.warnings].join("\n");
}
