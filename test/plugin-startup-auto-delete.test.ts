import { describe, expect, it, vi } from "vitest";

import { server as SessionJanitorPlugin } from "../src/index.js";
import { daysAgo, makeSession, NOW } from "./helpers.js";
import {
  createPluginInput,
  disabledConfigFiles,
  observeChatMessage,
  useTempConfigHome,
  writeGlobalConfig,
} from "./plugin-test-helpers.js";

useTempConfigHome();

describe("SessionJanitorPlugin startup auto delete", () => {
  it("runs startup auto delete once after observing a trusted chat session ID", async () => {
    const client = {
      session: {
        list: vi.fn(async () => ({
          data: [
            makeSession("current", daysAgo(1)),
            makeSession("old", daysAgo(40)),
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
        list: vi.fn(async () => ({
          data: [
            makeSession("current", daysAgo(1)),
            makeSession("old", daysAgo(40)),
          ],
        })),
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
            makeSession("current", daysAgo(1)),
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
            data: [
              makeSession("current", daysAgo(1)),
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

    await observeChatMessage(hooks);

    await vi.waitFor(() => expect(client.session.list).toHaveBeenCalledOnce());
    expect(client.session.delete).not.toHaveBeenCalled();

    resolveDryRunList!({
      data: [
        makeSession("current", daysAgo(1)),
        makeSession("old", daysAgo(40)),
      ],
    });
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
                  "config changed after the startup dry-run",
                ),
              ]),
            }),
          }),
        }),
      ),
    );
    expect(client.session.delete).not.toHaveBeenCalled();
    expect(client.session.list).toHaveBeenCalledOnce();
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
});
