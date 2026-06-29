import { describe, expect, it, vi } from "vitest";

import { server as SessionJanitorPlugin } from "../src/index.js";
import { daysAgo, makeSession, NOW } from "./helpers.js";
import {
  createPluginInput,
  disabledConfigFiles,
  useTempConfigHome,
} from "./plugin-test-helpers.js";

useTempConfigHome();

describe("SessionJanitorPlugin startup dry-run", () => {
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
});
