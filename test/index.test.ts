import { describe, expect, it, vi } from "vitest";

import { SessionJanitorPlugin } from "../src/index.js";

describe("SessionJanitorPlugin", () => {
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
