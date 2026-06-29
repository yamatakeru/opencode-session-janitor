import type { Session } from "@opencode-ai/sdk";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";

import type { SessionJanitorClient } from "../src/janitor.js";

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

export function createClient(
  sessions: Session[],
  deleteHandler: (id: string) => Promise<unknown> = async () => ({
    data: true,
  }),
): { client: SessionJanitorClient } {
  return {
    client: {
      session: {
        list: vi.fn(async () => ({ data: sessions })),
        delete: vi.fn(async ({ path }) => deleteHandler(path.id)) as never,
      },
      app: {
        log: vi.fn(async () => ({ data: true })),
      },
      tui: {
        showToast: vi.fn(async () => ({ data: true })),
      },
    },
  };
}

export async function createTempProject(
  files: Record<string, string> = {},
): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "session-janitor-"));
  const opencodeDir = join(projectDir, ".opencode");
  await mkdir(opencodeDir, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(opencodeDir, name), content, "utf8");
  }

  return projectDir;
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
