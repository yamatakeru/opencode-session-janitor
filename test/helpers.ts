import type { Session } from "@opencode-ai/sdk";

import { DAY_MS } from "../src/evaluate.js";

export const NOW = Date.UTC(2026, 0, 31, 0, 0, 0, 0);

export function daysAgo(days: number): number {
  return NOW - days * DAY_MS;
}

export function makeSession(
  id: string,
  updated: number,
  overrides: Partial<Session> = {},
): Session {
  return {
    id,
    projectID: "project-1",
    directory: "/work/project",
    title: id,
    version: "1.17.11",
    time: {
      created: updated,
      updated,
    },
    ...overrides,
  };
}
