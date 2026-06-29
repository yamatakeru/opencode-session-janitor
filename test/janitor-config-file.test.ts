import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runSessionJanitor } from "../src/janitor.js";
import { daysAgo, makeSession, NOW } from "./helpers.js";
import {
  createClient,
  createTempProject,
  useTempConfigHome,
  writeGlobalConfig,
} from "./janitor-test-helpers.js";

useTempConfigHome();

describe("runSessionJanitor config file integration", () => {
  it("loads the default global config file before listing sessions", async () => {
    await writeGlobalConfig(JSON.stringify({ retentionDays: 1 }));
    const { client } = createClient([makeSession("old", daysAgo(2))]);

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      trigger: "sessionIdle",
      now: NOW,
    });

    expect(result.output).toContain("Retention days: 1");
    expect(result.output).toContain("Candidates: 1");
    expect(result.metadata.configFile).toEqual(
      expect.objectContaining({
        loaded: true,
        files: expect.arrayContaining([
          expect.objectContaining({ kind: "global", loaded: true }),
        ]),
      }),
    );
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("blocks delete when global config enables deletion but project config cannot be checked", async () => {
    await writeGlobalConfig(
      JSON.stringify({ dryRun: false, allowAutoDelete: true }),
    );
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain(
      "Project config file skipped because configFileBaseDir is unavailable",
    );
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("loads the default project config file over the global config", async () => {
    await writeGlobalConfig(JSON.stringify({ retentionDays: 90 }));
    const projectDir = await createTempProject({
      "session-janitor.json": JSON.stringify({ retentionDays: 1 }),
    });
    const { client } = createClient([makeSession("old", daysAgo(2))]);

    try {
      const result = await runSessionJanitor({
        client,
        configFileBaseDir: projectDir,
        currentSessionID: "current",
        trigger: "sessionIdle",
        now: NOW,
      });

      expect(result.output).toContain("Retention days: 1");
      expect(result.output).toContain("Candidates: 1");
      expect(result.metadata.configFile).toEqual(
        expect.objectContaining({
          loaded: true,
          files: expect.arrayContaining([
            expect.objectContaining({ kind: "global", loaded: true }),
            expect.objectContaining({ kind: "project", loaded: true }),
          ]),
        }),
      );
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("ignores a missing default project config file", async () => {
    const projectDir = await createTempProject();
    const { client } = createClient([makeSession("newer", daysAgo(2))]);

    try {
      const result = await runSessionJanitor({
        client,
        configFileBaseDir: projectDir,
        currentSessionID: "current",
        trigger: "sessionIdle",
        now: NOW,
      });

      expect(result.output).toContain("Retention days: 30");
      expect(result.output).toContain("Candidates: 0");
      expect(result.metadata.configFile).toEqual(
        expect.objectContaining({ loaded: false }),
      );
      expect(client.session.list).toHaveBeenCalled();
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("fails before listing when an explicit project config file is missing", async () => {
    const projectDir = await createTempProject();
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    try {
      const result = await runSessionJanitor({
        client,
        configFileBaseDir: projectDir,
        pluginOptions: { projectConfigFile: ".opencode/missing.json" },
        currentSessionID: "current",
        now: NOW,
      });

      expect(result.output).toContain("Mode: validation-error");
      expect(result.output).toContain("Failed to read project config file");
      expect(client.session.list).not.toHaveBeenCalled();
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("fails before listing when explicit relative projectConfigFile has no base directory", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: { projectConfigFile: ".opencode/session-janitor.json" },
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain("projectConfigFile must be absolute");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("fails before listing when explicit absolute projectConfigFile is missing", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: {
        projectConfigFile: join(
          tmpdir(),
          "missing-session-janitor-config.json",
        ),
      },
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain("Failed to read project config file");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("fails before listing when globalConfigFile is relative", async () => {
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      pluginOptions: { globalConfigFile: "session-janitor.json" },
      currentSessionID: "current",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain("globalConfigFile must be absolute");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("fails before listing when a config file contains invalid JSON", async () => {
    const projectDir = await createTempProject({
      "session-janitor.json": "{ invalid",
    });
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    try {
      const result = await runSessionJanitor({
        client,
        configFileBaseDir: projectDir,
        currentSessionID: "current",
        trigger: "sessionIdle",
        now: NOW,
      });

      expect(result.output).toContain("Mode: validation-error");
      expect(result.output).toContain("invalid JSON");
      expect(client.session.list).not.toHaveBeenCalled();
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("fails before listing when the global config file contains invalid JSON", async () => {
    await writeGlobalConfig("{ invalid");
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      trigger: "sessionIdle",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain("invalid JSON");
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("blocks delete mode when config file options have warnings", async () => {
    const projectDir = await createTempProject({
      "session-janitor.json": JSON.stringify({
        dryRun: false,
        allowAutoDelete: true,
        typo: true,
      }),
    });
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    try {
      const result = await runSessionJanitor({
        client,
        configFileBaseDir: projectDir,
        currentSessionID: "current",
        trigger: "startup",
        now: NOW,
      });

      expect(result.output).toContain("Mode: validation-error");
      expect(result.output).toContain(
        "Unknown project config file key ignored: typo",
      );
      expect(client.session.list).not.toHaveBeenCalled();
      expect(client.session.delete).not.toHaveBeenCalled();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("blocks delete mode when global config file options have warnings", async () => {
    await writeGlobalConfig(
      JSON.stringify({
        dryRun: false,
        allowAutoDelete: true,
        typo: true,
      }),
    );
    const { client } = createClient([makeSession("old", daysAgo(40))]);

    const result = await runSessionJanitor({
      client,
      currentSessionID: "current",
      trigger: "startup",
      now: NOW,
    });

    expect(result.output).toContain("Mode: validation-error");
    expect(result.output).toContain(
      "Unknown global config file key ignored: typo",
    );
    expect(client.session.list).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });
});
