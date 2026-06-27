import type { Session } from "@opencode-ai/sdk";

import type { ResolvedSessionJanitorConfig } from "./config.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

export type SkipReason =
  | "missing_timestamp"
  | "invalid_timestamp"
  | "invalid_session_record"
  | "current_session"
  | "unknown_shared_status"
  | "shared_session"
  | "newer_than_retention"
  | "min_sessions_to_keep"
  | "max_delete_count";

export type CandidateReason = "older_than_retention";

export type SessionSummary = {
  id: string;
  title: string;
  directory: string;
  projectID: string;
  updated: number;
  updatedISO: string;
  ageDays: number;
  shared: boolean;
};

export type SessionCandidate = SessionSummary & {
  reason: CandidateReason;
};

export type SkippedSession = Partial<SessionSummary> & {
  id: string;
  title: string;
  directory?: string;
  projectID?: string;
  reason: SkipReason;
};

export type EvaluationResult = {
  totalSessions: number;
  candidates: SessionCandidate[];
  skipped: SkippedSession[];
  skippedCounts: Record<SkipReason, number>;
  maxDeleteCountApplied: boolean;
};

type EvaluateSessionsInput = {
  sessions: Session[];
  config: ResolvedSessionJanitorConfig;
  currentSessionID?: string;
  now?: number;
};

type TimestampResult =
  | { ok: true; updated: number }
  | { ok: false; reason: "missing_timestamp" | "invalid_timestamp" };

type SharedResult =
  | { ok: true; shared: boolean }
  | { ok: false; reason: "unknown_shared_status" };

type SessionIdentity = {
  id: string;
  title: string;
  directory: string;
  projectID: string;
};

type SessionIdentityResult =
  | { ok: true; identity: SessionIdentity }
  | { ok: false; skipped: SkippedSession };

export function evaluateSessions({
  sessions,
  config,
  currentSessionID,
  now = Date.now(),
}: EvaluateSessionsInput): EvaluationResult {
  const skipped: SkippedSession[] = [];
  const eligible: SessionCandidate[] = [];
  const minKeepProtectedIDs = getMinKeepProtectedIDs(
    sessions,
    config.minSessionsToKeep,
  );
  const cutoff = now - config.retentionDays * DAY_MS;

  for (const session of sessions) {
    const identity = getSessionIdentity(session);
    if (!identity.ok) {
      skipped.push(identity.skipped);
      continue;
    }
    const sessionIdentity = identity.identity;

    const timestamp = getUpdatedTimestamp(session);
    if (!timestamp.ok) {
      skipped.push(toSkippedSession(sessionIdentity, timestamp.reason));
      continue;
    }

    const base = toSessionSummary(sessionIdentity, timestamp.updated, now);

    if (
      config.excludeCurrentSession &&
      currentSessionID !== undefined &&
      sessionIdentity.id === currentSessionID
    ) {
      skipped.push({ ...base, reason: "current_session" });
      continue;
    }

    const shared = getSharedStatus(session);
    if (!shared.ok) {
      skipped.push({ ...base, reason: shared.reason });
      continue;
    }

    const summary = { ...base, shared: shared.shared };

    if (!config.includeShared && shared.shared) {
      skipped.push({ ...summary, reason: "shared_session" });
      continue;
    }

    if (timestamp.updated >= cutoff) {
      skipped.push({ ...summary, reason: "newer_than_retention" });
      continue;
    }

    if (minKeepProtectedIDs.has(sessionIdentity.id)) {
      skipped.push({ ...summary, reason: "min_sessions_to_keep" });
      continue;
    }

    eligible.push({ ...summary, reason: "older_than_retention" });
  }

  eligible.sort((left, right) => {
    const byUpdated = left.updated - right.updated;
    return byUpdated === 0 ? left.id.localeCompare(right.id) : byUpdated;
  });

  const candidates = eligible.slice(0, config.maxDeleteCount);
  const maxDeleteSkipped = eligible
    .slice(config.maxDeleteCount)
    .map<SkippedSession>((session) => ({
      ...session,
      reason: "max_delete_count",
    }));

  const allSkipped = [...skipped, ...maxDeleteSkipped];

  return {
    totalSessions: sessions.length,
    candidates,
    skipped: allSkipped,
    skippedCounts: countSkippedReasons(allSkipped),
    maxDeleteCountApplied: maxDeleteSkipped.length > 0,
  };
}

export function calculateAgeDays(updated: number, now: number): number {
  return Math.max(0, (now - updated) / DAY_MS);
}

function getMinKeepProtectedIDs(
  sessions: Session[],
  minSessionsToKeep: number,
): Set<string> {
  if (minSessionsToKeep === 0) {
    return new Set();
  }

  const sessionsByNewest = sessions.flatMap((session) => {
    const identity = getSessionIdentity(session);
    if (!identity.ok) {
      return [];
    }

    const timestamp = getUpdatedTimestamp(session);
    if (!timestamp.ok) {
      return [];
    }
    return [{ id: identity.identity.id, updated: timestamp.updated }];
  });

  sessionsByNewest.sort((left, right) => {
    const byUpdated = right.updated - left.updated;
    return byUpdated === 0 ? left.id.localeCompare(right.id) : byUpdated;
  });

  return new Set(
    sessionsByNewest.slice(0, minSessionsToKeep).map((session) => session.id),
  );
}

function getUpdatedTimestamp(session: Session): TimestampResult {
  const time = (session as { time?: { updated?: unknown } }).time;
  if (!time || time.updated === undefined || time.updated === null) {
    return { ok: false, reason: "missing_timestamp" };
  }

  if (typeof time.updated !== "number" || !Number.isFinite(time.updated)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  if (Number.isNaN(new Date(time.updated).getTime())) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  return { ok: true, updated: time.updated };
}

function getSessionIdentity(session: Session): SessionIdentityResult {
  const record = session as Partial<Record<keyof SessionIdentity, unknown>>;
  const id = getNonEmptyString(record.id);
  const title = getString(record.title);
  const directory = getString(record.directory);
  const projectID = getString(record.projectID);

  if (
    !id ||
    title === undefined ||
    directory === undefined ||
    projectID === undefined
  ) {
    return {
      ok: false,
      skipped: {
        id: id ?? "<invalid>",
        title: title ?? "<invalid>",
        directory,
        projectID,
        reason: "invalid_session_record",
      },
    };
  }

  return {
    ok: true,
    identity: {
      id,
      title,
      directory,
      projectID,
    },
  };
}

function getSharedStatus(session: Session): SharedResult {
  const share = (session as { share?: unknown }).share;
  if (share === undefined || share === null) {
    return { ok: true, shared: false };
  }
  if (typeof share !== "object" || Array.isArray(share)) {
    return { ok: false, reason: "unknown_shared_status" };
  }

  const url = (share as { url?: unknown }).url;
  if (typeof url === "string" && url.length > 0) {
    return { ok: true, shared: true };
  }

  return { ok: false, reason: "unknown_shared_status" };
}

function toSessionSummary(
  session: SessionIdentity,
  updated: number,
  now: number,
): Omit<SessionSummary, "shared"> {
  return {
    id: session.id,
    title: session.title,
    directory: session.directory,
    projectID: session.projectID,
    updated,
    updatedISO: new Date(updated).toISOString(),
    ageDays: calculateAgeDays(updated, now),
  };
}

function toSkippedSession(
  session: SessionIdentity,
  reason: SkipReason,
): SkippedSession {
  return {
    id: session.id,
    title: session.title,
    directory: session.directory,
    projectID: session.projectID,
    reason,
  };
}

function countSkippedReasons(
  skipped: SkippedSession[],
): Record<SkipReason, number> {
  const counts = {
    missing_timestamp: 0,
    invalid_timestamp: 0,
    invalid_session_record: 0,
    current_session: 0,
    unknown_shared_status: 0,
    shared_session: 0,
    newer_than_retention: 0,
    min_sessions_to_keep: 0,
    max_delete_count: 0,
  } satisfies Record<SkipReason, number>;

  for (const skippedSession of skipped) {
    counts[skippedSession.reason] += 1;
  }

  return counts;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}
