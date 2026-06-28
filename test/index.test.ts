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
    };

    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    try {
      const hooks = await SessionJanitorPlugin(createPluginInput(client), {
        configFile: false,
        dryRun: false,
      });

      expect(hooks).not.toHaveProperty("tool");
      await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());

      expect(client.session.list).toHaveBeenCalledOnce();
      expect(client.session.delete).not.toHaveBeenCalled();
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
                "dryRun:false ignored because startup runs are dry-run only.",
              ]),
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
    expect(client.session.delete).not.toHaveBeenCalled();

    resolveList!({ data: [] });
    await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());
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
      ).resolves.toEqual({});
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
      ).resolves.toEqual({});
      await vi.waitFor(() => expect(client.app.log).toHaveBeenCalled());

      expect(client.app.log).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            level: "error",
            message: "Session janitor failed to list sessions",
          }),
        }),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Session janitor startup dry-run failed"),
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
