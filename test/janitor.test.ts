import type { Session } from "@opencode-ai/sdk";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSessionJanitor } from "../src/janitor.js";
import type { SessionJanitorClient } from "../src/janitor.js";
import { daysAgo, makeSession, NOW } from "./helpers.js";

const tempConfigHomes: string[] = [];

beforeEach(async () => {
  const configHome = await mkdtemp(join(tmpdir(), "session-janitor-xdg-"));
  tempConfigHomes.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempConfigHomes
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("runSessionJanitor", () => {
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

  it("loads the default global config file before listing sessions", async () => {
    await writeGlobalConfig(JSON.stringify({ retentionDays: 1 }));
    const { client } = createClient([makeSession("old", daysAgo(2))]);

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      trigger: "sessionIdle",
      now: NOW,
    });

    expect(result.output).toContain("Retention days: 1");
    expect(result.output).toContain("Candidates: 1");
    expect(result.metadata.configFile).toEqual(
      expect.objectContaining({
        loaded: true,
        files: expect.arrayContaining([
          expect.objectContaining({ kind: "global", loaded: true }),
        ]),
      }),
    );
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("blocks delete when global config enables deletion but project config cannot be checked", async () => {
    await writeGlobalConfig(
      JSON.stringify({ dryRun: false, allowAutoDelete: true }),
    );
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain(
      "Project config file skipped because configFileBaseDir is unavailable",
    );
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("loads the default project config file over the global config", async () => {
    await writeGlobalConfig(JSON.stringify({ retentionDays: 90 }));
    const projectDir = await createTempProject({
      "session-janitor.json": JSON.stringify({ retentionDays: 1 }),
    });
    const { client } = createClient([makeSession("old", daysAgo(2))]);

    try {
      const result = await runSessionJanitor({
        client,
        configFileBaseDir: projectDir,
        currentSessionID: "current",
        trigger: "sessionIdle",
        now: NOW,
      });

      expect(result.output).toContain("Retention days: 1");
      expect(result.output).toContain("Candidates: 1");
      expect(result.metadata.configFile).toEqual(
        expect.objectContaining({
          loaded: true,
          files: expect.arrayContaining([
            expect.objectContaining({ kind: "global", loaded: true }),
            expect.objectContaining({ kind: "project", loaded: true }),
          ]),
        }),
      );
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("ignores a missing default project config file", async () => {
    const projectDir = await createTempProject();
    const { client } = createClient([makeSession("newer", daysAgo(2))]);

    try {
      const result = await runSessionJanitor({
        client,
        configFileBaseDir: projectDir,
        currentSessionID: "current",
        trigger: "sessionIdle",
        now: NOW,
      });

      expect(result.output).toContain("Retention days: 30");
      expect(result.output).toContain("Candidates: 0");
      expect(result.metadata.configFile).toEqual(
        expect.objectContaining({ loaded: false }),
      );
      expect(client.session.list).toHaveBeenCalled();
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("fails before listing when an explicit project config file is missing", async () => {
    const projectDir = await createTempProject();
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    try {
      const result = await runSessionJanitor({
        client,
        configFileBaseDir: projectDir,
        pluginOptions: { projectConfigFile: ".opencode/missing.json" },
        currentSessionID: "current",
        now: NOW,
      });

      expect(result.output).toContain("Mode: validation-error");
      expect(result.output).toContain("Failed to read project config file");
      expect(client.session.list).not.toHaveBeenCalled();
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("fails before listing when explicit relative projectConfigFile has no base directory", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: { projectConfigFile: ".opencode/session-janitor.json" },
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain("projectConfigFile must be absolute");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("fails before listing when explicit absolute projectConfigFile is missing", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        projectConfigFile: join(
          tmpdir(),
          "missing-session-janitor-config.json",
        ),
      },
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain("Failed to read project config file");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("fails before listing when globalConfigFile is relative", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: { globalConfigFile: "session-janitor.json" },
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain("globalConfigFile must be absolute");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("fails before listing when a config file contains invalid JSON", async () => {
    const projectDir = await createTempProject({
      "session-janitor.json": "{ invalid",
    });
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    try {
      const result = await runSessionJanitor({
        client,
        configFileBaseDir: projectDir,
        currentSessionID: "current",
        trigger: "sessionIdle",
        now: NOW,
      });

      expect(result.output).toContain("Mode: validation-error");
      expect(result.output).toContain("invalid JSON");
      expect(client.session.list).not.toHaveBeenCalled();
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("fails before listing when the global config file contains invalid JSON", async () => {
    await writeGlobalConfig("{ invalid");
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      trigger: "sessionIdle",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain("invalid JSON");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("blocks delete mode when config file options have warnings", async () => {
    const projectDir = await createTempProject({
      "session-janitor.json": JSON.stringify({
        dryRun: false,
        allowAutoDelete: true,
        typo: true,
      }),
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

      expect(result.output).toContain("Mode: validation-error");
      expect(result.output).toContain(
        "Unknown project config file key ignored: typo",
      );
      expect(client.session.list).not.toHaveBeenCalled();
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("blocks delete mode when global config file options have warnings", async () => {
    await writeGlobalConfig(
      JSON.stringify({
        dryRun: false,
        allowAutoDelete: true,
        typo: true,
      }),
    );
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain(
      "Unknown global config file key ignored: typo",
    );
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
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

  it("allows startup delete only when auto delete gates are satisfied", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

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

    expect(result.output).toContain("Mode: delete");
    expect(result.output).toContain("Deleted: 1");
    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: "old" } });
  });

  it("applies maxDeleteCount during startup auto delete", async () => {
    const { client } = createClient([
      makeSession("oldest", daysAgo(70)),
      makeSession("middle", daysAgo(60)),
      makeSession("newest-old", daysAgo(50)),
    ]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
        maxDeleteCount: 2,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(client.session.delete).toHaveBeenCalledTimes(2);
    expect(client.session.delete).toHaveBeenNthCalledWith(1, {
      path: { id: "oldest" },
    });
    expect(client.session.delete).toHaveBeenNthCalledWith(2, {
      path: { id: "middle" },
    });
    expect(result.output).toContain("Max delete count applied: yes");
  });

  it("protects shared and current sessions during startup auto delete", async () => {
    const { client } = createClient([
      makeSession("current", daysAgo(90)),
      makeSession("shared", daysAgo(80), {
        share: { url: "https://example.com" },
      }),
      makeSession("old", daysAgo(70)),
    ]);

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

    expect(client.session.delete).toHaveBeenCalledTimes(1);
    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: "old" } });
    expect(result.output).toContain("current_session: 1");
    expect(result.output).toContain("shared_session: 1");
  });

  it("auto deletes shared sessions when includeShared is enabled", async () => {
    const { client } = createClient([
      makeSession("shared", daysAgo(40), {
        share: { url: "https://example.com/s/shared" },
      }),
    ]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        includeShared: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: delete");
    expect(result.output).toContain("Deleted: 1");
    expect(client.session.delete).toHaveBeenCalledWith({
      path: { id: "shared" },
    });
  });

  it("does not auto delete when current-session protection is disabled", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        excludeCurrentSession: false,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: dry-run");
    expect(result.output).toContain(
      "startup auto delete requires excludeCurrentSession:true",
    );
    expect(client.session.delete).not.toHaveBeenCalled();
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

  it("fails closed before listing when delete mode cannot verify current session", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: guard-error");
    expect(result.output).toContain("No sessions were listed or deleted");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("deletes candidates only when dryRun is false", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

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

    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: "old" } });
    expect(result.output).toContain("Mode: delete");
    expect(result.output).toContain("Deleted: 1");
    expect(result.output).toContain("Failed: 0");
  });

  it("continues after partial delete failure", async () => {
    const old = makeSession("old", daysAgo(50));
    const older = makeSession("older", daysAgo(60));
    const { client } = createClient([old, older], async (id) => {
      if (id === "older") {
        return {
          data: undefined,
          error: { message: "cannot delete", code: "E_DELETE", status: 500 },
        };
      }
      return { data: true };
    });

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

    expect(client.session.delete).toHaveBeenCalledTimes(2);
    expect(result.output).toContain("Deleted: 1");
    expect(result.output).toContain("Failed: 1");
    expect(result.output).toContain("cannot delete");
    expect(result.output).toContain("code=E_DELETE");
    expect(result.output).toContain("status=500");
    expect(client.app?.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ level: "error" }),
      }),
    );
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

  it("aborts delete loop after an unexpected delete exception", async () => {
    const { client } = createClient(
      [
        makeSession("oldest", daysAgo(70)),
        makeSession("middle", daysAgo(60)),
        makeSession("newest-old", daysAgo(50)),
      ],
      async () => {
        throw new TypeError("sdk shape changed");
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
      now: NOW,
    });

    expect(client.session.delete).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("Failed: 1");
    expect(result.output).toContain(
      "Delete aborted: TypeError: sdk shape changed",
    );
    expect(result.metadata.deleteAborted).toBe("TypeError: sdk shape changed");
  });

  it("aborts delete loop on malformed delete responses", async () => {
    const { client } = createClient(
      [makeSession("oldest", daysAgo(70)), makeSession("middle", daysAgo(60))],
      async () => ({ data: "true" }),
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
      now: NOW,
    });

    expect(client.session.delete).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("UnexpectedDeleteResponseError");
    expect(result.output).toContain("Delete aborted:");
  });

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

function createClient(
  sessions: Session[],
  deleteHandler: (id: string) => Promise<unknown> = async () => ({
    data: true,
  }),
): { client: SessionJanitorClient } {
  return {
    client: {
      session: {
        list: vi.fn(async () => ({ data: sessions })),
        delete: vi.fn(async ({ path }) => deleteHandler(path.id)) as never,
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
      tui: {
        showToast: vi.fn(async () => ({ data: true })),
      },
    },
  };
}

async function createTempProject(
  files: Record<string, string> = {},
): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "session-janitor-"));
  const opencodeDir = join(projectDir, ".opencode");
  await mkdir(opencodeDir, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(opencodeDir, name), content, "utf8");
  }

  return projectDir;
}

async function writeGlobalConfig(content: string): Promise<void> {
  const configHome = process.env.XDG_CONFIG_HOME;
  if (!configHome) {
    throw new Error("XDG_CONFIG_HOME must be set for this test");
  }

  const opencodeDir = join(configHome, "opencode");
  await mkdir(opencodeDir, { recursive: true });
  await writeFile(join(opencodeDir, "session-janitor.json"), content, "utf8");
}
