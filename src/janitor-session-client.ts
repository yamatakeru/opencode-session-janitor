import type { Session } from "@opencode-ai/sdk";

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

export type LogLevel = "debug" | "info" | "error" | "warn";
export type TuiToastVariant = "info" | "success" | "warning" | "error";

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
        level: LogLevel;
        message: string;
        extra?: Record<string, unknown>;
      };
    }): Promise<MaybeResponseFields<boolean>>;
  };
  tui?: {
    showToast(input: {
      body: {
        title?: string;
        message: string;
        variant: TuiToastVariant;
        duration?: number;
      };
    }): Promise<unknown>;
  };
};

export async function listSessions(
  client: SessionJanitorClient,
): Promise<Session[]> {
  const sessions = unwrapResponse(
    await client.session.list(),
    "client.session.list()",
  );
  if (!Array.isArray(sessions)) {
    throw new Error("client.session.list() returned a non-array response");
  }
  return sessions;
}

export async function deleteSession(
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

export function unwrapResponse<T>(
  response: MaybeResponseFields<T>,
  label: string,
): T {
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

export function formatUnknownError(error: unknown): string {
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

export class RecoverableDeleteFailureError extends Error {
  override name = "RecoverableDeleteFailureError";
}

class UnexpectedDeleteResponseError extends Error {
  override name = "UnexpectedDeleteResponseError";
}
