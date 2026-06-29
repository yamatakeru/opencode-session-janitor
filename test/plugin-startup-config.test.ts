import { describe, expect, it } from "vitest";

import { getStartupAutoDeleteConfig } from "../src/plugin-startup-config.js";
import { disabledConfigFiles } from "./plugin-test-helpers.js";

describe("getStartupAutoDeleteConfig", () => {
  it("returns not-enabled when startup auto delete is disabled", async () => {
    await expect(
      getStartupAutoDeleteConfig({
        pluginOptions: {
          ...disabledConfigFiles,
          dryRun: false,
          allowAutoDelete: false,
        },
        configFileBaseDir: "/work/project",
      }),
    ).resolves.toEqual({ kind: "not-enabled" });
  });

  it("returns not-enabled for non-startup delete configs", async () => {
    await expect(
      getStartupAutoDeleteConfig({
        pluginOptions: {
          ...disabledConfigFiles,
          dryRun: false,
          trigger: "sessionIdle",
          allowAutoDelete: true,
        },
        configFileBaseDir: "/work/project",
      }),
    ).resolves.toEqual({ kind: "not-enabled" });
  });

  it("blocks startup auto delete when current-session protection is disabled", async () => {
    const result = await getStartupAutoDeleteConfig({
      pluginOptions: {
        ...disabledConfigFiles,
        dryRun: false,
        allowAutoDelete: true,
        excludeCurrentSession: false,
      },
      configFileBaseDir: "/work/project",
    });

    expect(result).toEqual({
      kind: "blocked",
      errors: [
        "Refusing startup auto delete because excludeCurrentSession:true is required.",
      ],
      warnings: [],
    });
  });
});
