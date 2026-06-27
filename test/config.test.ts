import { describe, expect, it } from "vitest";

import { defaultSessionJanitorConfig, resolveConfig } from "../src/config.js";

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
  });

  it("lets tool args override plugin options", () => {
    const result = resolveConfig(
      { retentionDays: 90, dryRun: true },
      { retentionDays: 7, dryRun: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to be valid");
    }
    expect(result.config.retentionDays).toBe(7);
    expect(result.config.dryRun).toBe(false);
  });

  it("rejects invalid values", () => {
    const result = resolveConfig({
      retentionDays: 0,
      dryRun: "false",
      includeShared: "no",
      excludeCurrentSession: 1,
      minSessionsToKeep: -1,
      maxDeleteCount: 0,
      trigger: "never",
      allowAutoDelete: "yes",
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
      "minSessionsToKeep must be a non-negative integer",
      "maxDeleteCount must be a positive integer",
      "trigger must be one of manual, startup, or sessionIdle",
      "allowAutoDelete must be boolean",
    ]);
  });

  it("rejects explicit null option objects", () => {
    const pluginResult = resolveConfig(null);
    const toolResult = resolveConfig(undefined, null);

    expect(pluginResult.ok).toBe(false);
    if (pluginResult.ok) {
      throw new Error("expected plugin config to be invalid");
    }
    expect(pluginResult.errors).toEqual(["plugin options must be an object"]);

    expect(toolResult.ok).toBe(false);
    if (toolResult.ok) {
      throw new Error("expected tool config to be invalid");
    }
    expect(toolResult.errors).toEqual(["tool args must be an object"]);
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
});
