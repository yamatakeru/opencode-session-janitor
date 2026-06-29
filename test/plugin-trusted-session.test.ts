import { describe, expect, it, vi } from "vitest";

import { server as SessionJanitorPlugin } from "../src/index.js";
import { daysAgo, makeSession } from "./helpers.js";
import {
  createPluginInput,
  disabledConfigFiles,
  observeChatMessage,
  observeCommandExecuteBefore,
  useTempConfigHome,
} from "./plugin-test-helpers.js";

useTempConfigHome();

describe("SessionJanitorPlugin trusted session hooks", () => {
  it("does not register session.idle or session.status event handling", async () => {
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
});
