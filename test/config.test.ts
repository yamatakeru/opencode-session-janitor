import { describe, expect, it } from "vitest";

import {
  defaultSessionJanitorConfig,
  getCleanupOptions,
  resolveConfig,
  resolveConfigFromOptionSources,
  resolveConfigFromSources,
} from "../src/config.js";

describe("resolveConfig", () => {
  it("uses safe defaults", () => {
    const result = resolveConfig();

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to be valid");
    }
    expect(result.config).toEqual(defaultSessionJanitorConfig);
    expect(result.config.dryRun).toBe(true);
    expect(result.config.includeShared).toBe(false);
    expect(result.config.excludeCurrentSession).toBe(true);
    expect(result.config.maxDeleteCount).toBe(10);
    expect(result.config.notifyTui).toBe(true);
  });

  it("uses plugin options as the highest-precedence runtime policy source", () => {
    const result = resolveConfig({ retentionDays: 7, dryRun: false });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to be valid");
    }
    expect(result.config.retentionDays).toBe(7);
    expect(result.config.dryRun).toBe(false);
  });

  it("merges config file and plugin options in order", () => {
    const result = resolveConfigFromSources(
      { retentionDays: 60, dryRun: true, maxDeleteCount: 20 },
      { retentionDays: 30, includeShared: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to be valid");
    }
    expect(result.config.retentionDays).toBe(30);
    expect(result.config.dryRun).toBe(true);
    expect(result.config.includeShared).toBe(true);
    expect(result.config.maxDeleteCount).toBe(20);
  });

  it("does not treat config path options as cleanup options", () => {
    const result = resolveConfig(
      getCleanupOptions({
        retentionDays: 14,
        globalConfigFile: false,
        projectConfigFile: ".opencode/session-janitor.json",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to be valid");
    }
    expect(result.config.retentionDays).toBe(14);
    expect(result.warnings).toEqual([]);
  });

  it("treats the retired configFile option as unknown", () => {
    const result = resolveConfig(
      getCleanupOptions({
        retentionDays: 14,
        configFile: ".opencode/session-janitor.json",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to be valid");
    }
    expect(result.config.retentionDays).toBe(14);
    expect(result.warnings).toEqual([
      "Unknown plugin options key ignored: configFile",
    ]);
  });

  it("keeps invalid non-object cleanup options invalid", () => {
    const result = resolveConfig(getCleanupOptions([]));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected config to be invalid");
    }
    expect(result.errors).toEqual(["plugin options must be an object"]);
  });

  it("rejects invalid values", () => {
    const result = resolveConfig({
      retentionDays: 0,
      dryRun: "false",
      includeShared: "no",
      excludeCurrentSession: 1,
      maxDeleteCount: Number.MAX_SAFE_INTEGER + 1,
      trigger: "never",
      allowAutoDelete: "yes",
      notifyTui: "sometimes",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected config to be invalid");
    }
    expect(result.errors).toEqual([
      "retentionDays must be a positive integer",
      "dryRun must be boolean",
      "includeShared must be boolean",
      "excludeCurrentSession must be boolean",
      'maxDeleteCount must be a positive integer or "unlimited"',
      "trigger must be one of startup or sessionIdle",
      "allowAutoDelete must be boolean",
      "notifyTui must be boolean",
    ]);
  });

  it("allows unlimited maxDeleteCount", () => {
    const result = resolveConfig({ maxDeleteCount: "unlimited" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to be valid");
    }
    expect(result.config.maxDeleteCount).toBe("unlimited");
  });

  it("rejects explicit null option objects", () => {
    const pluginResult = resolveConfig(null);

    expect(pluginResult.ok).toBe(false);
    if (pluginResult.ok) {
      throw new Error("expected plugin config to be invalid");
    }
    expect(pluginResult.errors).toEqual(["plugin options must be an object"]);
  });

  it("warns and ignores unknown options", () => {
    const result = resolveConfig({ retentionDays: 14, extra: true });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to be valid");
    }
    expect(result.config.retentionDays).toBe(14);
    expect(result.warnings).toEqual([
      "Unknown plugin options key ignored: extra",
    ]);
  });

  it("warns and ignores unknown config file options", () => {
    const result = resolveConfigFromSources({ retentionDays: 14, extra: true });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to be valid");
    }
    expect(result.config.retentionDays).toBe(14);
    expect(result.warnings).toEqual(["Unknown config file key ignored: extra"]);
  });

  it("merges labeled config file sources in order", () => {
    const result = resolveConfigFromOptionSources(
      [
        {
          label: "global config file",
          options: { retentionDays: 90, maxDeleteCount: 20 },
        },
        {
          label: "project config file",
          options: { retentionDays: 14, includeShared: true },
        },
      ],
      { retentionDays: 7 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to be valid");
    }
    expect(result.config.retentionDays).toBe(7);
    expect(result.config.includeShared).toBe(true);
    expect(result.config.maxDeleteCount).toBe(20);
  });

  it("labels unknown keys by config file source", () => {
    const result = resolveConfigFromOptionSources([
      { label: "global config file", options: { globalTypo: true } },
      { label: "project config file", options: { projectTypo: true } },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to be valid");
    }
    expect(result.warnings).toEqual([
      "Unknown global config file key ignored: globalTypo",
      "Unknown project config file key ignored: projectTypo",
    ]);
  });
});
