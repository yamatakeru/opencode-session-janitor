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

  it("does not register an agent-callable session_janitor custom tool", async () => {
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

    expect(hooks).not.toHaveProperty("tool");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });
});
