import { rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { runSessionJanitor } from "../src/janitor.js";
import type { SessionJanitorClient } from "../src/janitor.js";
import { daysAgo, makeSession, NOW } from "./helpers.js";
import {
  createClient,
  createTempProject,
  useTempConfigHome,
} from "./janitor-test-helpers.js";

useTempConfigHome();

describe("runSessionJanitor dry-run and validation", () => {
  it("returns an empty dry-run summary", async () => {
    const { client } = createClient([]);

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.output).toContain("Mode: dry-run");
    expect(result.output).toContain("Total sessions: 0");
    expect(result.output).toContain("Candidates: 0");
    expect(client.session.delete).not.toHaveBeenCalled();
    expect(client.app?.log).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          level: "info",
          message: "Session janitor dry-run completed",
          extra: expect.objectContaining({
            tuiNotification: { ok: true },
          }),
        }),
      }),
    );
    expect(client.tui?.showToast).toHaveBeenCalledWith({
      body: {
        title: "Session Janitor",
        message:
          "Dry-run completed: 0 cleanup candidates. No sessions were deleted.",
        variant: "success",
        duration: 10000,
      },
    });
    expect(result.metadata.tuiNotification).toEqual({ ok: true });
  });

  it("does not show a TUI toast when disabled", async () => {
    const { client } = createClient([]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: { notifyTui: false },
      currentSessionID: "current",
      now: NOW,
    });

    expect(client.tui?.showToast).not.toHaveBeenCalled();
    expect(result.metadata.tuiNotification).toEqual({
      ok: false,
      error: "TUI notifications are disabled",
    });
  });

  it("does not fail a run when TUI toast fails", async () => {
    const { client } = createClient([]);
    client.tui!.showToast = vi.fn(async () => ({
      data: undefined,
      error: { message: "not connected" },
    }));

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.metadata.ok).toBe(true);
    expect(result.metadata.tuiNotification).toEqual({
      ok: false,
      error: "client.tui.showToast failed: not connected",
    });
  });

  it("does not list or delete when validation fails", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: { retentionDays: 0, dryRun: false },
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
    expect(client.tui?.showToast).toHaveBeenCalledWith({
      body: {
        title: "Session Janitor",
        message:
          "Run failed (validation-error); check the app log for details.",
        variant: "error",
        duration: 10000,
      },
    });
  });

  it("does not list or delete in delete mode when config has unknown options", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        retentionDay: 365,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain("Refusing delete");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
    expect(client.tui?.showToast).toHaveBeenCalledWith({
      body: {
        title: "Session Janitor",
        message:
          "Run failed (validation-error); check the app log for details.",
        variant: "error",
        duration: 10000,
      },
    });
  });

  it("reports session.list failures without deleting", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({
          data: undefined,
          error: { message: "boom" },
        })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
      tui: {
        showToast: vi.fn(async () => ({ data: true })),
      },
    } satisfies SessionJanitorClient;

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: list-error");
    expect(result.output).toContain("boom");
    expect(client.session.delete).not.toHaveBeenCalled();
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: {
        title: "Session Janitor",
        message: "Run failed (delete); check the app log for details.",
        variant: "error",
        duration: 10000,
      },
    });
  });

  it("does not call delete during dry-run", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.output).toContain("Candidates: 1");
    expect(result.output).toContain("Dry-run only: no sessions were deleted.");
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("keeps startup runs dry-run unless auto delete is explicitly allowed", async () => {
    const projectDir = await createTempProject({
      "session-janitor.json": JSON.stringify({ dryRun: false }),
    });
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    try {
      const result = await runSessionJanitor({
        client,
        configFileBaseDir: projectDir,
        currentSessionID: "current",
        trigger: "startup",
        now: NOW,
      });

      expect(result.output).toContain("Mode: dry-run");
      expect(result.output).toContain(
        "dryRun:false ignored because startup auto delete requires allowAutoDelete:true.",
      );
      expect(result.metadata.config).toEqual(
        expect.objectContaining({ dryRun: true }),
      );
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("warns when dry-run cannot verify current-session protection", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      now: NOW,
    });

    expect(result.output).toContain("Warnings:");
    expect(result.output).toContain(
      "current-session protection cannot be verified",
    );
    expect(client.session.delete).not.toHaveBeenCalled();
  });
});
