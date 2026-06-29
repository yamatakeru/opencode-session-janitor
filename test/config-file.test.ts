import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSessionJanitorConfigFile } from "../src/config-file.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("loadSessionJanitorConfigFile", () => {
  it("loads global config before project config", async () => {
    const configHome = await createTempDir("session-janitor-xdg-");
    const projectDir = await createTempDir("session-janitor-project-");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);

    await writeConfig(
      join(configHome, "opencode", "session-janitor.json"),
      JSON.stringify({ retentionDays: 90, maxDeleteCount: 20 }),
    );
    await writeConfig(
      join(projectDir, ".opencode", "session-janitor.json"),
      JSON.stringify({ retentionDays: 14, includeShared: true }),
    );

    const result = await loadSessionJanitorConfigFile({ baseDir: projectDir });

    expect(result.errors).toEqual([]);
    expect(result.loaded).toBe(true);
    expect(result.options).toEqual({
      retentionDays: 14,
      maxDeleteCount: 20,
      includeShared: true,
    });
    expect(result.optionSources.map((source) => source.label)).toEqual([
      "global config file",
      "project config file",
    ]);
    expect(result.files).toEqual([
      expect.objectContaining({ kind: "global", loaded: true }),
      expect.objectContaining({ kind: "project", loaded: true }),
    ]);
  });

  it("ignores missing default global and project config files", async () => {
    const configHome = await createTempDir("session-janitor-xdg-");
    const projectDir = await createTempDir("session-janitor-project-");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);

    const result = await loadSessionJanitorConfigFile({ baseDir: projectDir });

    expect(result).toEqual(
      expect.objectContaining({
        loaded: false,
        options: undefined,
        optionSources: [],
        errors: [],
      }),
    );
    expect(result.files).toEqual([
      expect.objectContaining({ kind: "global", loaded: false, errors: [] }),
      expect.objectContaining({ kind: "project", loaded: false, errors: [] }),
    ]);
  });

  it("can disable global and project config files independently", async () => {
    const configHome = await createTempDir("session-janitor-xdg-");
    const projectDir = await createTempDir("session-janitor-project-");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);

    await writeConfig(
      join(configHome, "opencode", "session-janitor.json"),
      JSON.stringify({ retentionDays: 90 }),
    );
    await writeConfig(
      join(projectDir, ".opencode", "session-janitor.json"),
      JSON.stringify({ retentionDays: 14 }),
    );

    await expect(
      loadSessionJanitorConfigFile({
        baseDir: projectDir,
        pluginOptions: { globalConfigFile: false },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        loaded: true,
        options: { retentionDays: 14 },
      }),
    );

    await expect(
      loadSessionJanitorConfigFile({
        baseDir: projectDir,
        pluginOptions: { projectConfigFile: false },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        loaded: true,
        options: { retentionDays: 90 },
      }),
    );

    await expect(
      loadSessionJanitorConfigFile({
        baseDir: projectDir,
        pluginOptions: {
          globalConfigFile: false,
          projectConfigFile: false,
        },
      }),
    ).resolves.toEqual(expect.objectContaining({ loaded: false, files: [] }));
  });

  it("rejects relative global config file overrides", async () => {
    const result = await loadSessionJanitorConfigFile({
      pluginOptions: { globalConfigFile: "session-janitor.json" },
    });

    expect(result.loaded).toBe(false);
    expect(result.errors).toEqual([
      "globalConfigFile must be absolute or start with ~/: session-janitor.json",
    ]);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "global", loaded: false }),
      ]),
    );
  });

  it("records when the default project config is skipped without a base directory", async () => {
    const configHome = await createTempDir("session-janitor-xdg-");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);

    const result = await loadSessionJanitorConfigFile({});

    expect(result.warnings).toEqual([
      "Project config file skipped because configFileBaseDir is unavailable. Set projectConfigFile:false to opt out explicitly.",
    ]);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "project", loaded: false, errors: [] }),
      ]),
    );
  });

  it("rejects relative XDG_CONFIG_HOME values", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", "relative-config-home");

    const result = await loadSessionJanitorConfigFile({});

    expect(result.loaded).toBe(false);
    expect(result.errors).toEqual([
      "XDG_CONFIG_HOME must be absolute when set: relative-config-home",
    ]);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "global", loaded: false }),
      ]),
    );
  });
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
