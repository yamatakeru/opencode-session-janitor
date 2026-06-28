import { describe, expect, it, vi } from "vitest";

import { server as SessionJanitorPlugin } from "../src/index.js";

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

  it("registers the session_janitor custom tool", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [] })),
        delete: vi.fn(async () => ({ data: true })),
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
    };

    const hooks = await SessionJanitorPlugin(
      {
        client,
        project: {},
        directory: "/work/project",
        worktree: "/work/project",
        experimental_workspace: { register: vi.fn() },
        serverUrl: new URL("http://localhost"),
        $: vi.fn(),
      } as never,
      {},
    );

    expect(hooks.tool?.session_janitor).toBeDefined();

    const result = await hooks.tool?.session_janitor.execute(
      {},
      {
        sessionID: "current",
        messageID: "message",
        agent: "agent",
        directory: "/work/project",
        worktree: "/work/project",
        abort: new AbortController().signal,
        metadata: vi.fn(),
        ask: vi.fn(),
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        title: "Session janitor dry-run",
        output: expect.stringContaining("Mode: dry-run"),
      }),
    );
    expect(client.session.delete).not.toHaveBeenCalled();
  });
});
