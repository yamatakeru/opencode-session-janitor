import { describe, expect, it, vi } from "vitest";

import { server as SessionJanitorPlugin } from "../src/index.js";
import { daysAgo, makeSession } from "./helpers.js";
import {
  createPluginInput,
  disabledConfigFiles,
  observeChatMessage,
  useTempConfigHome,
} from "./plugin-test-helpers.js";

useTempConfigHome();

describe("SessionJanitorPlugin startup failures", () => {
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
