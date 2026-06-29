import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server as SessionJanitorPlugin } from "../src/index.js";
import { daysAgo, makeSession, NOW } from "./helpers.js";

const disabledConfigFiles = {
  globalConfigFile: false,
  projectConfigFile: false,
};
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

describe("SessionJanitorPlugin", () => {
  it("keeps the package root plugin-only", async () => {
    const module = await import("../src/index.js");

    expect(Object.keys(module)).toEqual(["server"]);
    expect(module.server).toBe(SessionJanitorPlugin);
  });

  it("exposes reusable runtime APIs from the api entrypoint", async () => {
    const module = await import("../src/api.js");

    expect(module).not.toHaveProperty("default");
    expect(module).not.toHaveProperty("server");
    expect(module).toEqual(
      expect.objectContaining({
        calculateAgeDays: expect.any(Function),
        defaultSessionJanitorConfig: expect.any(Object),
        defaultGlobalSessionJanitorConfigFile: expect.any(String),
        defaultSessionJanitorConfigFile: expect.any(String),
        evaluateSessions: expect.any(Function),
        resolveConfig: expect.any(Function),
        resolveConfigFromOptionSources: expect.any(Function),
        resolveConfigFromSources: expect.any(Function),
        runSessionJanitor: expect.any(Function),
      }),
    );
  });

  it("starts a background startup dry-run without registering an agent-callable tool", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
      tui: {
        showToast: vi.fn(async () => ({ data: true })),
      },
    };

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    try {
      const hooks = await SessionJanitorPlugin(createPluginInput(client), {
        ...disabledConfigFiles,
        dryRun: false,
      });

      expect(hooks).not.toHaveProperty("tool");
      expect(hooks).not.toHaveProperty("event");
      expect(hooks["chat.message"]).toEqual(expect.any(Function));
      expect(hooks["command.execute.before"]).toEqual(expect.any(Function));
      await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());

      expect(client.session.list).toHaveBeenCalledOnce();
      expect(client.session.delete).not.toHaveBeenCalled();
      expect(client.tui.showToast).not.toHaveBeenCalled();
      expect(client.app.log).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            level: "info",
            message: "Session janitor dry-run completed",
            extra: expect.objectContaining({
              trigger: "startup",
              mode: "dry-run",
              candidateCount: 1,
              warnings: expect.arrayContaining([
                "dryRun:false ignored because this run was forced to dry-run.",
              ]),
              tuiNotification: {
                ok: false,
                error: "TUI toast suppressed",
              },
            }),
          }),
        }),
      );

      await vi.advanceTimersByTimeAsync(3000);
      expect(client.tui.showToast).toHaveBeenCalledOnce();
      expect(client.app.log).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            level: "info",
            message: "Session janitor delayed TUI toast completed",
            extra: expect.objectContaining({
              trigger: "startup",
              mode: "dry-run",
              candidateCount: 1,
              tuiNotification: { ok: true },
            }),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not block plugin startup on the background dry-run", async () => {
    let resolveList: (value: { data: [] }) => void;
    const listCompleted = new Promise<{ data: [] }>((resolve) => {
      resolveList = resolve;
    });
    const client = {
      session: {
        list: vi.fn(() => listCompleted),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(createPluginInput(client), {
      ...disabledConfigFiles,
    });

    expect(hooks).not.toHaveProperty("tool");
    expect(hooks).not.toHaveProperty("event");
    expect(hooks["chat.message"]).toEqual(expect.any(Function));
    expect(hooks["command.execute.before"]).toEqual(expect.any(Function));
    expect(client.session.delete).not.toHaveBeenCalled();

    resolveList!({ data: [] });
    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());
  });

  it("runs startup auto delete once after observing a trusted chat session ID", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    try {
      const hooks = await SessionJanitorPlugin(createPluginInput(client), {
        ...disabledConfigFiles,
        dryRun: false,
        allowAutoDelete: true,
      });

      await observeChatMessage(hooks);
      await observeChatMessage(hooks);

      await vi.waitFor(() => expect(client.session.delete).toHaveBeenCalled());

      expect(client.session.delete).toHaveBeenCalledTimes(1);
      expect(client.session.delete).toHaveBeenCalledWith({
        path: { id: "old" },
      });
      await vi.waitFor(() =>
        expect(client.app.log).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              message: "Session janitor delete completed",
              extra: expect.objectContaining({
                trigger: "startup",
                mode: "delete",
                deletedCount: 1,
              }),
            }),
          }),
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses global config for startup auto delete", async () => {
    await writeGlobalConfig(
      JSON.stringify({
        dryRun: false,
        allowAutoDelete: true,
      }),
    );
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(createPluginInput(client));

    await observeChatMessage(hooks);

    await vi.waitFor(() =>
      expect(client.session.delete).toHaveBeenCalledOnce(),
    );
    expect(client.session.delete).toHaveBeenCalledWith({
      path: { id: "old" },
    });
  });

  it("runs startup auto delete for shared sessions when includeShared is enabled", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({
          data: [
            makeSession("shared", daysAgo(40), {
              share: { url: "https://example.com/s/shared" },
            }),
          ],
        })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    try {
      const hooks = await SessionJanitorPlugin(createPluginInput(client), {
        ...disabledConfigFiles,
        dryRun: false,
        allowAutoDelete: true,
        includeShared: true,
      });

      await observeChatMessage(hooks);

      await vi.waitFor(() =>
        expect(client.session.delete).toHaveBeenCalledOnce(),
      );
      expect(client.session.delete).toHaveBeenCalledWith({
        path: { id: "shared" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the startup dry-run before auto delete", async () => {
    let resolveDryRunList: (value: {
      data: ReturnType<typeof makeSession>[];
    }) => void;
    const dryRunList = new Promise<{ data: ReturnType<typeof makeSession>[] }>(
      (resolve) => {
        resolveDryRunList = resolve;
      },
    );
    const client = {
      session: {
        list: vi
          .fn()
          .mockImplementationOnce(() => dryRunList)
          .mockImplementationOnce(async () => ({
            data: [makeSession("old", daysAgo(40))],
          })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(createPluginInput(client), {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
    });

    await observeChatMessage(hooks);

    await vi.waitFor(() => expect(client.session.list).toHaveBeenCalledOnce());
    expect(client.session.delete).not.toHaveBeenCalled();

    resolveDryRunList!({ data: [makeSession("old", daysAgo(40))] });
    await vi.waitFor(() =>
      expect(client.session.delete).toHaveBeenCalledOnce(),
    );
  });

  it("does not auto delete if the startup dry-run failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      session: {
        list: vi.fn(async () => ({ error: { message: "boom" } })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    try {
      const hooks = await SessionJanitorPlugin(createPluginInput(client), {
        ...disabledConfigFiles,
        dryRun: false,
        allowAutoDelete: true,
      });

      await observeChatMessage(hooks);

      await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());
      expect(client.session.list).toHaveBeenCalledOnce();
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not auto delete if config changes after the startup dry-run", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };
    const pluginOptions = {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
      retentionDays: 30,
    };

    const hooks = await SessionJanitorPlugin(
      createPluginInput(client),
      pluginOptions,
    );
    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());

    pluginOptions.retentionDays = 10;
    await observeChatMessage(hooks);

    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("logs when startup auto delete is blocked after the startup dry-run", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };
    const pluginOptions: Record<string, unknown> = {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
    };

    const hooks = await SessionJanitorPlugin(
      createPluginInput(client),
      pluginOptions,
    );
    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());

    pluginOptions.retentionDay = 365;
    await observeChatMessage(hooks);

    expect(client.session.delete).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(client.app.log).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            level: "error",
            message: "Session janitor startup auto delete blocked",
            extra: expect.objectContaining({
              autoDeleteTrigger: "startup-armed",
              trustedSessionSource: "chat.message",
              errors: expect.arrayContaining([
                expect.stringContaining(
                  "Unknown plugin options key ignored: retentionDay",
                ),
              ]),
            }),
          }),
        }),
      ),
    );
  });

  it("warns when startup auto delete blocked logging fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi
          .fn()
          .mockResolvedValueOnce({ data: true })
          .mockResolvedValueOnce({ error: { message: "log failed" } }),
      },
    };
    const pluginOptions: Record<string, unknown> = {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
    };

    try {
      const hooks = await SessionJanitorPlugin(
        createPluginInput(client),
        pluginOptions,
      );
      await vi.waitFor(() => expect(client.app.log).toHaveBeenCalledOnce());

      pluginOptions.retentionDay = 365;
      await observeChatMessage(hooks);

      expect(client.session.delete).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            "Also failed to log startup auto delete block: Error: client.app.log failed: log failed",
          ),
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not register session.idle or session.status event handling", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(createPluginInput(client), {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
    });

    expect(hooks).not.toHaveProperty("event");
    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("does not auto delete until a trusted session hook is observed", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    await SessionJanitorPlugin(createPluginInput(client), {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
    });

    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());

    expect(client.session.list).toHaveBeenCalledOnce();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("runs startup auto delete once from command.execute.before", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(createPluginInput(client), {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
    });

    await observeCommandExecuteBefore(hooks);
    await observeCommandExecuteBefore(hooks);

    await vi.waitFor(() =>
      expect(client.session.delete).toHaveBeenCalledOnce(),
    );
    expect(client.session.delete).toHaveBeenCalledWith({
      path: { id: "old" },
    });
  });

  it("runs startup auto delete once when both trusted hooks are observed", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(createPluginInput(client), {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
    });

    await observeChatMessage(hooks);
    await observeCommandExecuteBefore(hooks);

    await vi.waitFor(() =>
      expect(client.session.delete).toHaveBeenCalledOnce(),
    );
    expect(client.session.list).toHaveBeenCalledTimes(2);
  });

  it("protects the trusted session itself when it is an old candidate", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({
          data: [
            makeSession("current", daysAgo(40)),
            makeSession("old", daysAgo(40)),
          ],
        })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(createPluginInput(client), {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
    });

    await observeChatMessage(hooks, "current");

    await vi.waitFor(() =>
      expect(client.session.delete).toHaveBeenCalledOnce(),
    );
    expect(client.session.delete).toHaveBeenCalledWith({
      path: { id: "old" },
    });
    expect(client.session.delete).not.toHaveBeenCalledWith({
      path: { id: "current" },
    });
  });

  it("ignores blank trusted session IDs without consuming the auto delete latch", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(createPluginInput(client), {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
    });

    await observeChatMessage(hooks, "   ");
    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());
    expect(client.session.delete).not.toHaveBeenCalled();

    await observeChatMessage(hooks, "current");

    await vi.waitFor(() =>
      expect(client.session.delete).toHaveBeenCalledOnce(),
    );
  });

  it("blocks startup auto delete for non-normalized trusted session IDs", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(createPluginInput(client), {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
    });

    await observeChatMessage(hooks, " current ");

    await vi.waitFor(() =>
      expect(client.app.log).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            level: "error",
            message: "Session janitor startup auto delete blocked",
            extra: expect.objectContaining({
              autoDeleteTrigger: "startup-armed",
              trustedSessionSource: "chat.message",
              errors: expect.arrayContaining([
                expect.stringContaining("trusted sessionID was not normalized"),
              ]),
            }),
          }),
        }),
      ),
    );
    await observeChatMessage(hooks, "current");
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("blocks startup auto delete if trusted hooks disagree before delete starts", async () => {
    let resolveDryRunList: (value: {
      data: ReturnType<typeof makeSession>[];
    }) => void;
    const dryRunList = new Promise<{ data: ReturnType<typeof makeSession>[] }>(
      (resolve) => {
        resolveDryRunList = resolve;
      },
    );
    const client = {
      session: {
        list: vi
          .fn()
          .mockImplementationOnce(() => dryRunList)
          .mockImplementationOnce(async () => ({
            data: [makeSession("old", daysAgo(40))],
          })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(createPluginInput(client), {
      ...disabledConfigFiles,
      dryRun: false,
      allowAutoDelete: true,
    });

    await observeChatMessage(hooks, "first");
    await observeCommandExecuteBefore(hooks, "second");

    await vi.waitFor(() =>
      expect(client.app.log).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            level: "error",
            message: "Session janitor startup auto delete blocked",
            extra: expect.objectContaining({
              autoDeleteTrigger: "startup-armed",
              trustedSessionSource: "command.execute.before",
              firstTrustedSessionSource: "chat.message",
              conflictingTrustedSessionSource: "command.execute.before",
              errors: expect.arrayContaining([
                expect.stringContaining(
                  "multiple trusted session hooks reported different session IDs",
                ),
              ]),
            }),
          }),
        }),
      ),
    );

    resolveDryRunList!({ data: [makeSession("old", daysAgo(40))] });
    await vi.waitFor(() =>
      expect(client.app.log).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            message: "Session janitor dry-run completed",
          }),
        }),
      ),
    );
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("aborts startup auto delete when trusted hooks disagree during delete evaluation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let resolveDeleteList: (value: {
      data: ReturnType<typeof makeSession>[];
    }) => void;
    const deleteList = new Promise<{ data: ReturnType<typeof makeSession>[] }>(
      (resolve) => {
        resolveDeleteList = resolve;
      },
    );
    const client = {
      session: {
        list: vi
          .fn()
          .mockResolvedValueOnce({ data: [makeSession("old", daysAgo(40))] })
          .mockImplementationOnce(() => deleteList),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    try {
      const hooks = await SessionJanitorPlugin(createPluginInput(client), {
        ...disabledConfigFiles,
        dryRun: false,
        allowAutoDelete: true,
      });

      await observeChatMessage(hooks, "first");
      await vi.waitFor(() =>
        expect(client.session.list).toHaveBeenCalledTimes(2),
      );
      await observeCommandExecuteBefore(hooks, "second");

      await vi.waitFor(() =>
        expect(client.app.log).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              level: "error",
              message: "Session janitor startup auto delete blocked",
              extra: expect.objectContaining({
                autoDeleteTrigger: "startup-armed",
                trustedSessionSource: "command.execute.before",
                firstTrustedSessionSource: "chat.message",
                conflictingTrustedSessionSource: "command.execute.before",
                errors: expect.arrayContaining([
                  expect.stringContaining(
                    "multiple trusted session hooks reported different session IDs",
                  ),
                ]),
              }),
            }),
          }),
        ),
      );

      resolveDeleteList!({ data: [makeSession("old", daysAgo(40))] });
      await vi.waitFor(() =>
        expect(client.app.log).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              level: "warn",
              message: "Session janitor cancelled",
              extra: expect.objectContaining({
                mode: "cancelled",
                cancellationStage: "after-list",
              }),
            }),
          }),
        ),
      );
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not run auto delete after observing a trusted session ID without opt-in", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(createPluginInput(client), {
      ...disabledConfigFiles,
      dryRun: false,
    });

    await observeChatMessage(hooks);

    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("does not fail plugin startup when startup dry-run cannot be logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [] })),
        delete: vi.fn(async () => ({ data: true })),
      },
    };

    try {
      await expect(
        SessionJanitorPlugin(createPluginInput(client), disabledConfigFiles),
      ).resolves.toEqual({
        "chat.message": expect.any(Function),
        "command.execute.before": expect.any(Function),
      });
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());

      expect(client.session.list).toHaveBeenCalledOnce();
      expect(client.session.delete).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Session janitor startup dry-run could not be logged",
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not auto delete when the startup dry-run could not be logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [makeSession("old", daysAgo(40))] })),
        delete: vi.fn(async () => ({ data: true })),
      },
    };

    try {
      const hooks = await SessionJanitorPlugin(createPluginInput(client), {
        ...disabledConfigFiles,
        dryRun: false,
        allowAutoDelete: true,
      });
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());

      await observeChatMessage(hooks);

      expect(client.session.delete).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            "Refusing startup auto delete because the startup dry-run could not be logged",
          ),
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not fail plugin startup when startup dry-run evaluation fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      session: {
        list: vi.fn(async () => ({ error: { message: "boom" } })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    try {
      await expect(
        SessionJanitorPlugin(createPluginInput(client), disabledConfigFiles),
      ).resolves.toEqual({
        "chat.message": expect.any(Function),
        "command.execute.before": expect.any(Function),
      });
      await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());

      expect(client.app.log).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            level: "error",
            message: "Session janitor failed to list sessions",
          }),
        }),
      );
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("Session janitor startup dry-run failed"),
        ),
      );
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

function createPluginInput(client: unknown): never {
  return {
    client,
    project: {},
    directory: "/work/project",
    worktree: "/work/project",
    experimental_workspace: { register: vi.fn() },
    serverUrl: new URL("http://localhost"),
    $: vi.fn(),
  } as never;
}

type PluginHooks = Awaited<ReturnType<typeof SessionJanitorPlugin>>;

async function observeChatMessage(
  hooks: PluginHooks,
  sessionID = "current",
): Promise<void> {
  const hook = hooks["chat.message"];
  if (!hook) {
    throw new Error("chat.message hook is not registered");
  }

  await hook({ sessionID }, { message: {} as never, parts: [] });
}

async function observeCommandExecuteBefore(
  hooks: PluginHooks,
  sessionID = "current",
): Promise<void> {
  const hook = hooks["command.execute.before"];
  if (!hook) {
    throw new Error("command.execute.before hook is not registered");
  }

  await hook({ command: "test", sessionID, arguments: "" }, { parts: [] });
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
