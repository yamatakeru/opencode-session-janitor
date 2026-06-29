import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { afterEach, beforeEach, vi } from "vitest";

import { server as SessionJanitorPlugin } from "../src/index.js";

export const disabledConfigFiles = {
  globalConfigFile: false,
  projectConfigFile: false,
} as const;

export type PluginHooks = Awaited<ReturnType<typeof SessionJanitorPlugin>>;

export function useTempConfigHome(): void {
  const tempConfigHomes: string[] = [];

  beforeEach(async () => {
    const configHome = await mkdtemp(join(tmpdir(), "session-janitor-xdg-"));
    tempConfigHomes.push(configHome);
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      tempConfigHomes
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
}

export function createPluginInput(client: unknown): PluginInput {
  const input = {
    client: client as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: "/work/project",
    worktree: "/work/project",
    experimental_workspace: { register: vi.fn() },
    serverUrl: new URL("http://localhost"),
    $: vi.fn() as unknown as PluginInput["$"],
  } satisfies PluginInput;

  return input;
}

export async function observeChatMessage(
  hooks: PluginHooks,
  sessionID = "current",
): Promise<void> {
  const hook = hooks["chat.message"];
  if (!hook) {
    throw new Error("chat.message hook is not registered");
  }

  await hook({ sessionID }, { message: {} as never, parts: [] });
}

export async function observeCommandExecuteBefore(
  hooks: PluginHooks,
  sessionID = "current",
): Promise<void> {
  const hook = hooks["command.execute.before"];
  if (!hook) {
    throw new Error("command.execute.before hook is not registered");
  }

  await hook({ command: "test", sessionID, arguments: "" }, { parts: [] });
}

export async function writeGlobalConfig(content: string): Promise<void> {
  const configHome = process.env.XDG_CONFIG_HOME;
  if (!configHome) {
    throw new Error("XDG_CONFIG_HOME must be set for this test");
  }

  const opencodeDir = join(configHome, "opencode");
  await mkdir(opencodeDir, { recursive: true });
  await writeFile(join(opencodeDir, "session-janitor.json"), content, "utf8");
}
