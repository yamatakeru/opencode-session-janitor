import { describe, expect, it } from "vitest";

import { runSessionJanitor } from "../src/janitor.js";
import { daysAgo, makeSession, NOW } from "./helpers.js";
import { createClient, useTempConfigHome } from "./janitor-test-helpers.js";

useTempConfigHome();

describe("runSessionJanitor delete mode", () => {
  it("allows startup delete only when auto delete gates are satisfied", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: delete");
    expect(result.output).toContain("Deleted: 1");
    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: "old" } });
  });

  it("applies maxDeleteCount during startup auto delete", async () => {
    const { client } = createClient([
      makeSession("oldest", daysAgo(70)),
      makeSession("middle", daysAgo(60)),
      makeSession("newest-old", daysAgo(50)),
    ]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
        maxDeleteCount: 2,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(client.session.delete).toHaveBeenCalledTimes(2);
    expect(client.session.delete).toHaveBeenNthCalledWith(1, {
      path: { id: "oldest" },
    });
    expect(client.session.delete).toHaveBeenNthCalledWith(2, {
      path: { id: "middle" },
    });
    expect(result.output).toContain("Max delete count applied: yes");
  });

  it("protects shared and current sessions during startup auto delete", async () => {
    const { client } = createClient([
      makeSession("current", daysAgo(90)),
      makeSession("shared", daysAgo(80), {
        share: { url: "https://example.com" },
      }),
      makeSession("old", daysAgo(70)),
    ]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(client.session.delete).toHaveBeenCalledTimes(1);
    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: "old" } });
    expect(result.output).toContain("current_session: 1");
    expect(result.output).toContain("shared_session: 1");
  });

  it("auto deletes shared sessions when includeShared is enabled", async () => {
    const { client } = createClient([
      makeSession("shared", daysAgo(40), {
        share: { url: "https://example.com/s/shared" },
      }),
    ]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        includeShared: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: delete");
    expect(result.output).toContain("Deleted: 1");
    expect(client.session.delete).toHaveBeenCalledWith({
      path: { id: "shared" },
    });
  });

  it("does not auto delete when current-session protection is disabled", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        excludeCurrentSession: false,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: dry-run");
    expect(result.output).toContain(
      "startup auto delete requires excludeCurrentSession:true",
    );
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("fails closed before listing when delete mode cannot verify current session", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: guard-error");
    expect(result.output).toContain("No sessions were listed or deleted");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("deletes candidates only when dryRun is false", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: "old" } });
    expect(result.output).toContain("Mode: delete");
    expect(result.output).toContain("Deleted: 1");
    expect(result.output).toContain("Failed: 0");
  });

  it("continues after partial delete failure", async () => {
    const old = makeSession("old", daysAgo(50));
    const older = makeSession("older", daysAgo(60));
    const { client } = createClient([old, older], async (id) => {
      if (id === "older") {
        return {
          data: undefined,
          error: { message: "cannot delete", code: "E_DELETE", status: 500 },
        };
      }
      return { data: true };
    });

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(client.session.delete).toHaveBeenCalledTimes(2);
    expect(result.output).toContain("Deleted: 1");
    expect(result.output).toContain("Failed: 1");
    expect(result.output).toContain("cannot delete");
    expect(result.output).toContain("code=E_DELETE");
    expect(result.output).toContain("status=500");
    expect(client.app?.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ level: "error" }),
      }),
    );
  });

  it("aborts delete loop after an unexpected delete exception", async () => {
    const { client } = createClient(
      [
        makeSession("oldest", daysAgo(70)),
        makeSession("middle", daysAgo(60)),
        makeSession("newest-old", daysAgo(50)),
      ],
      async () => {
        throw new TypeError("sdk shape changed");
      },
    );

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(client.session.delete).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("Failed: 1");
    expect(result.output).toContain(
      "Delete aborted: TypeError: sdk shape changed",
    );
    expect(result.metadata.deleteAborted).toBe("TypeError: sdk shape changed");
  });

  it("aborts delete loop on malformed delete responses", async () => {
    const { client } = createClient(
      [makeSession("oldest", daysAgo(70)), makeSession("middle", daysAgo(60))],
      async () => ({ data: "true" }),
    );

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        dryRun: false,
        allowAutoDelete: true,
        projectConfigFile: false,
      },
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(client.session.delete).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("UnexpectedDeleteResponseError");
    expect(result.output).toContain("Delete aborted:");
  });
});
