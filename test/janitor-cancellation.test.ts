import { describe, expect, it, vi } from "vitest";

import { runSessionJanitor } from "../src/janitor.js";
import type { SessionJanitorClient } from "../src/janitor.js";
import { daysAgo, makeSession, NOW } from "./helpers.js";
import { createClient, useTempConfigHome } from "./janitor-test-helpers.js";

useTempConfigHome();

describe("runSessionJanitor cancellation", () => {
  it("stops before listing when already cancelled", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);
    const controller = new AbortController();
    controller.abort();

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      abortSignal: controller.signal,
      now: NOW,
    });

    expect(result.output).toContain("Mode: cancelled");
    expect(result.metadata.cancellationStage).toBe("before-list");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("reports cancellation after listing before dry-run completion", async () => {
    const controller = new AbortController();
    const client = {
      session: {
        list: vi.fn(async () => {
          controller.abort();
          return { data: [] };
        }),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    } satisfies SessionJanitorClient;

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      abortSignal: controller.signal,
      now: NOW,
    });

    expect(result.output).toContain("Mode: cancelled");
    expect(result.output).toContain("Sessions were listed");
    expect(result.metadata.ok).toBe(false);
    expect(result.metadata.cancellationStage).toBe("after-list");
    expect(client.session.delete).not.toHaveBeenCalled();
    expect(client.app.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: "Session janitor cancelled",
        }),
      }),
    );
  });

  it("reports cancellation after evaluation before delete mode starts", async () => {
    const controller = new AbortController();
    const session = makeSession("old", daysAgo(40));
    Object.defineProperty(session, "share", {
      get() {
        controller.abort();
        return undefined;
      },
    });
    const { client } = createClient([session]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      abortSignal: controller.signal,
      now: NOW,
    });

    expect(result.output).toContain("Mode: cancelled");
    expect(result.output).toContain("listed and evaluated");
    expect(result.metadata.ok).toBe(false);
    expect(result.metadata.cancellationStage).toBe("after-evaluation");
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("stops delete loop when cancelled between candidates", async () => {
    const controller = new AbortController();
    const { client } = createClient(
      [
        makeSession("oldest", daysAgo(70)),
        makeSession("middle", daysAgo(60)),
        makeSession("newest-old", daysAgo(50)),
      ],
      async () => {
        controller.abort();
        return { data: true };
      },
    );

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      abortSignal: controller.signal,
      now: NOW,
    });

    expect(client.session.delete).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("Deleted: 1");
    expect(result.output).toContain(
      "Delete aborted: Session janitor was cancelled by the user.",
    );
    expect(result.metadata.ok).toBe(false);
    expect(client.app?.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: "Session janitor delete aborted",
        }),
      }),
    );
  });

  it("reports cancellation during the final in-flight delete", async () => {
    const controller = new AbortController();
    const { client } = createClient(
      [makeSession("old", daysAgo(40))],
      async () => {
        controller.abort();
        return { data: true };
      },
    );

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      abortSignal: controller.signal,
      now: NOW,
    });

    expect(client.session.delete).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("Deleted: 1");
    expect(result.output).toContain(
      "Delete aborted: Session janitor was cancelled by the user.",
    );
    expect(result.metadata.ok).toBe(false);
    expect(client.app?.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: "Session janitor delete aborted",
        }),
      }),
    );
  });
});
