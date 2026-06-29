import { describe, expect, it, vi } from "vitest";

import { runSessionJanitor } from "../src/janitor.js";
import type { SessionJanitorClient } from "../src/janitor.js";
import { NOW } from "./helpers.js";
import { useTempConfigHome } from "./janitor-test-helpers.js";

useTempConfigHome();

describe("runSessionJanitor logging failures", () => {
  it("surfaces logging failures in metadata", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => {
          throw new Error("log failed");
        }),
      },
    } satisfies SessionJanitorClient;

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.metadata.logging).toEqual({
      ok: false,
      error: "client.app.log failed: Error: log failed",
    });
    expect(result.output).toContain("Logging warning:");
    expect(result.output).toContain("log failed");
  });

  it("surfaces field-style logging errors in metadata", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({
          data: undefined,
          error: { message: "bad log" },
        })),
      },
    } satisfies SessionJanitorClient;

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.metadata.logging).toEqual({
      ok: false,
      error: "client.app.log failed: Error: client.app.log failed: bad log",
    });
    expect(result.output).toContain("Logging warning:");
    expect(result.output).toContain("bad log");
  });
});
