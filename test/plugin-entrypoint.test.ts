import { describe, expect, it } from "vitest";

import { server as SessionJanitorPlugin } from "../src/index.js";

describe("SessionJanitorPlugin entrypoints", () => {
  it("keeps the package root plugin-only", async () => {
    const module = await import("../src/index.js");

    expect(Object.keys(module)).toEqual(["server"]);
    expect(module.server).toBe(SessionJanitorPlugin);
  });

  it("exposes reusable runtime APIs from the api entrypoint", async () => {
    const module = await import("../src/api.js");

    expect(module).not.toHaveProperty("default");
    expect(module).not.toHaveProperty("server");
    expect(module).toEqual(
      expect.objectContaining({
        calculateAgeDays: expect.any(Function),
        defaultSessionJanitorConfig: expect.any(Object),
        defaultGlobalSessionJanitorConfigFile: expect.any(String),
        defaultSessionJanitorConfigFile: expect.any(String),
        evaluateSessions: expect.any(Function),
        resolveConfig: expect.any(Function),
        resolveConfigFromOptionSources: expect.any(Function),
        resolveConfigFromSources: expect.any(Function),
        runSessionJanitor: expect.any(Function),
      }),
    );
  });
});
