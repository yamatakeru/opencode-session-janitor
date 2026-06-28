import { describe, expect, it } from "vitest";

import { defaultSessionJanitorConfig } from "../src/config.js";
import { calculateAgeDays, DAY_MS, evaluateSessions } from "../src/evaluate.js";
import { daysAgo, makeSession, NOW } from "./helpers.js";

describe("calculateAgeDays", () => {
  it("calculates fractional age in days", () => {
    expect(calculateAgeDays(NOW - 2.5 * DAY_MS, NOW)).toBe(2.5);
  });
});

describe("evaluateSessions", () => {
  it("treats the retention boundary as not old enough", () => {
    const result = evaluateSessions({
      sessions: [
        makeSession("boundary", daysAgo(30)),
        makeSession("old", daysAgo(30) - 1),
      ],
      config: defaultSessionJanitorConfig,
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.candidates.map((session) => session.id)).toEqual(["old"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "boundary",
          reason: "newer_than_retention",
        }),
      ]),
    );
  });

  it("skips sessions with missing or invalid timestamps", () => {
    const result = evaluateSessions({
      sessions: [
        makeSession("missing", daysAgo(40), { time: {} as never }),
        makeSession("invalid", daysAgo(40), {
          time: { updated: "bad" } as never,
        }),
        makeSession("out-of-range", Number.MAX_VALUE),
      ],
      config: defaultSessionJanitorConfig,
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.skipped.map((session) => session.reason)).toEqual([
      "missing_timestamp",
      "invalid_timestamp",
      "invalid_timestamp",
    ]);
  });

  it("skips malformed session records", () => {
    const result = evaluateSessions({
      sessions: [makeSession("", daysAgo(40))],
      config: defaultSessionJanitorConfig,
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.skipped[0]).toEqual(
      expect.objectContaining({ reason: "invalid_session_record" }),
    );
  });

  it("skips shared sessions by default", () => {
    const result = evaluateSessions({
      sessions: [
        makeSession("shared", daysAgo(40), {
          share: { url: "https://example.com/s/shared" },
        }),
      ],
      config: defaultSessionJanitorConfig,
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.skipped[0]).toEqual(
      expect.objectContaining({ id: "shared", reason: "shared_session" }),
    );
  });

  it("skips the current session by default", () => {
    const result = evaluateSessions({
      sessions: [makeSession("current", daysAgo(40))],
      config: defaultSessionJanitorConfig,
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.skipped[0]).toEqual(
      expect.objectContaining({ id: "current", reason: "current_session" }),
    );
  });

  it("applies maxDeleteCount to eligible old sessions", () => {
    const result = evaluateSessions({
      sessions: [
        makeSession("oldest", daysAgo(70)),
        makeSession("middle", daysAgo(60)),
        makeSession("newest-old", daysAgo(50)),
      ],
      config: { ...defaultSessionJanitorConfig, maxDeleteCount: 2 },
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.candidates.map((session) => session.id)).toEqual([
      "oldest",
      "middle",
    ]);
    expect(result.maxDeleteCountApplied).toBe(true);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "newest-old",
          reason: "max_delete_count",
        }),
      ]),
    );
  });

  it("does not cap eligible old sessions when maxDeleteCount is unlimited", () => {
    const result = evaluateSessions({
      sessions: [
        makeSession("oldest", daysAgo(70)),
        makeSession("middle", daysAgo(60)),
        makeSession("newest-old", daysAgo(50)),
      ],
      config: { ...defaultSessionJanitorConfig, maxDeleteCount: "unlimited" },
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.candidates.map((session) => session.id)).toEqual([
      "oldest",
      "middle",
      "newest-old",
    ]);
    expect(result.maxDeleteCountApplied).toBe(false);
    expect(
      result.skipped.some((session) => session.reason === "max_delete_count"),
    ).toBe(false);
  });
});
