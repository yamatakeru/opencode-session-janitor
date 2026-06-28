import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export const defaultSessionJanitorConfigFile = ".opencode/session-janitor.json";

export type ConfigFileLoadResult = {
  path?: string;
  loaded: boolean;
  options?: unknown;
  errors: string[];
};

export async function loadSessionJanitorConfigFile(input: {
  baseDir?: string;
  pluginOptions?: unknown;
}): Promise<ConfigFileLoadResult> {
  const setting = getConfigFileSetting(input.pluginOptions);
  if (setting.ok === false) {
    return { loaded: false, errors: [setting.error] };
  }
  if (setting.value === false) {
    return { loaded: false, errors: [] };
  }
  if (input.baseDir === undefined && setting.value === undefined) {
    return { loaded: false, errors: [] };
  }

  const resolved = resolveConfigPath(
    input.baseDir,
    setting.value ?? defaultSessionJanitorConfigFile,
  );
  if (resolved.ok === false) {
    return { loaded: false, errors: [resolved.error] };
  }

  const configPath = resolved.path;
  const explicit = setting.value !== undefined;

  try {
    const content = await readFile(configPath, "utf8");
    const parsed = parseJsonConfig(content, configPath);
    if (parsed.ok === false) {
      return { path: configPath, loaded: false, errors: [parsed.error] };
    }
    if (!isRecord(parsed.value) || Array.isArray(parsed.value)) {
      return {
        path: configPath,
        loaded: false,
        errors: [`Config file must contain a JSON object: ${configPath}`],
      };
    }
    return {
      path: configPath,
      loaded: true,
      options: parsed.value,
      errors: [],
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT" && !explicit) {
      return { path: configPath, loaded: false, errors: [] };
    }

    return {
      path: configPath,
      loaded: false,
      errors: [
        `Failed to read config file ${configPath}: ${formatError(error)}`,
      ],
    };
  }
}

function getConfigFileSetting(
  pluginOptions: unknown,
): { ok: true; value?: string | false } | { ok: false; error: string } {
  if (!isRecord(pluginOptions) || !("configFile" in pluginOptions)) {
    return { ok: true };
  }

  const value = pluginOptions.configFile;
  if (value === false) {
    return { ok: true, value };
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return { ok: true, value };
  }

  return { ok: false, error: "configFile must be a non-empty string or false" };
}

function resolveConfigPath(
  baseDir: string | undefined,
  configFile: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (isAbsolute(configFile)) {
    return { ok: true, path: configFile };
  }
  if (baseDir === undefined) {
    return {
      ok: false,
      error: `configFile must be absolute when configFileBaseDir is unavailable: ${configFile}`,
    };
  }
  return { ok: true, path: resolve(baseDir, configFile) };
}

function parseJsonConfig(
  content: string,
  configPath: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch (error) {
    return {
      ok: false,
      error: `Config file contains invalid JSON ${configPath}: ${formatError(error)}`,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
