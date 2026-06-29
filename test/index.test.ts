import { describe, expect, it, vi } from "vitest";

import { server as SessionJanitorPlugin } from "../src/index.js";
import { daysAgo, makeSession, NOW } from "./helpers.js";

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
        defaultSessionJanitorConfigFile: expect.any(String),
        evaluateSessions: expect.any(Function),
        resolveConfig: expect.any(Function),
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
        configFile: false,
        dryRun: false,
      });

      expect(hooks).not.toHaveProperty("tool");
      expect(hooks.event).toEqual(expect.any(Function));
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
      configFile: false,
    });

    expect(hooks).not.toHaveProperty("tool");
    expect(hooks.event).toEqual(expect.any(Function));
    expect(client.session.delete).not.toHaveBeenCalled();

    resolveList!({ data: [] });
    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());
  });

  it("runs startup auto delete once after observing a session ID", async () => {
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
        configFile: false,
        dryRun: false,
        allowAutoDelete: true,
      });

      await hooks.event?.({
        event: {
          type: "session.idle",
          properties: { sessionID: "current" },
        } as never,
      });
      await hooks.event?.({
        event: {
          type: "command.executed",
          properties: { sessionID: "current", name: "test" },
        } as never,
      });

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
      configFile: false,
      dryRun: false,
      allowAutoDelete: true,
    });

    const eventRun = hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "current" },
      } as never,
    });

    await vi.waitFor(() => expect(client.session.list).toHaveBeenCalledOnce());
    expect(client.session.delete).not.toHaveBeenCalled();

    resolveDryRunList!({ data: [makeSession("old", daysAgo(40))] });
    await eventRun;
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
        configFile: false,
        dryRun: false,
        allowAutoDelete: true,
      });

      await hooks.event?.({
        event: {
          type: "session.idle",
          properties: { sessionID: "current" },
        } as never,
      });

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
      configFile: false,
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
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "current" },
      } as never,
    });

    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("does not treat session info events as current-session observations", async () => {
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
      configFile: false,
      dryRun: false,
      allowAutoDelete: true,
    });

    await hooks.event?.({
      event: {
        type: "session.updated",
        properties: { info: makeSession("other", daysAgo(1)) },
      } as never,
    });

    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("does not run auto delete after observing a session ID without opt-in", async () => {
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
      configFile: false,
      dryRun: false,
    });

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "current" },
      } as never,
    });

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
        SessionJanitorPlugin(createPluginInput(client), { configFile: false }),
      ).resolves.toEqual({ event: expect.any(Function) });
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
        SessionJanitorPlugin(createPluginInput(client), { configFile: false }),
      ).resolves.toEqual({ event: expect.any(Function) });
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
