import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const defaultSessionJanitorConfigFile = ".opencode/session-janitor.json";
export const defaultGlobalSessionJanitorConfigFile =
  "~/.config/opencode/session-janitor.json";

export type ConfigFileKind = "global" | "project";

export type ConfigFileSourceResult = {
  kind: ConfigFileKind;
  path?: string;
  loaded: boolean;
  errors: string[];
};

export type ConfigFileOptionSource = {
  label: string;
  options?: unknown;
};

export type ConfigFileLoadResult = {
  path?: string;
  loaded: boolean;
  options?: unknown;
  optionSources: ConfigFileOptionSource[];
  files: ConfigFileSourceResult[];
  warnings: string[];
  errors: string[];
};

export async function loadSessionJanitorConfigFile(input: {
  baseDir?: string;
  pluginOptions?: unknown;
}): Promise<ConfigFileLoadResult> {
  const settings = getConfigFileSettings(input.pluginOptions);
  if (settings.ok === false) {
    return emptyLoadResult([settings.error]);
  }

  const sources = resolveConfigFileSources(input.baseDir, settings.value);
  if (sources.errors.length > 0) {
    return {
      path: undefined,
      loaded: false,
      options: undefined,
      optionSources: [],
      files: sources.files,
      warnings: sources.warnings,
      errors: sources.errors,
    };
  }

  const files: ConfigFileSourceResult[] = [];
  const optionSources: ConfigFileOptionSource[] = [];
  const mergedOptions: Record<string, unknown> = {};
  const warnings = [...sources.warnings];
  const errors: string[] = [];

  for (const source of sources.sources) {
    const loaded = await loadSingleConfigFile(source);
    files.push({
      kind: source.kind,
      path: source.path,
      loaded: loaded.loaded,
      errors: loaded.errors,
    });
    errors.push(...loaded.errors);

    if (loaded.loaded) {
      Object.assign(mergedOptions, loaded.options);
      optionSources.push({ label: source.label, options: loaded.options });
    }
  }
  files.push(...sources.files);

  return {
    path: getPrimaryConfigPath(files),
    loaded: optionSources.length > 0,
    options: optionSources.length > 0 ? mergedOptions : undefined,
    optionSources,
    files,
    warnings,
    errors,
  };
}

function emptyLoadResult(errors: string[]): ConfigFileLoadResult {
  return {
    loaded: false,
    optionSources: [],
    files: [],
    warnings: [],
    errors,
  };
}

type ConfigFileSettings = {
  globalConfigFile?: string | false;
  projectConfigFile?: string | false;
};

type ResolvedConfigFileSource = {
  kind: ConfigFileKind;
  label: string;
  path: string;
  explicit: boolean;
};

type LoadedConfigFile =
  | {
      loaded: true;
      options: Record<string, unknown>;
      errors: [];
    }
  | {
      loaded: false;
      errors: string[];
    };

function getConfigFileSettings(
  pluginOptions: unknown,
): { ok: true; value: ConfigFileSettings } | { ok: false; error: string } {
  const globalSetting = getPathSetting(pluginOptions, "globalConfigFile");
  if (globalSetting.ok === false) {
    return globalSetting;
  }

  const projectSetting = getPathSetting(pluginOptions, "projectConfigFile");
  if (projectSetting.ok === false) {
    return projectSetting;
  }

  return {
    ok: true,
    value: {
      globalConfigFile: globalSetting.value,
      projectConfigFile: projectSetting.value,
    },
  };
}

function getPathSetting(
  pluginOptions: unknown,
  key: "globalConfigFile" | "projectConfigFile",
): { ok: true; value?: string | false } | { ok: false; error: string } {
  if (!isRecord(pluginOptions) || !(key in pluginOptions)) {
    return { ok: true };
  }

  const value = pluginOptions[key];
  if (value === undefined) {
    return { ok: true };
  }
  if (value === false) {
    return { ok: true, value };
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return { ok: true, value };
  }

  return { ok: false, error: `${key} must be a non-empty string or false` };
}

function resolveConfigFileSources(
  baseDir: string | undefined,
  settings: ConfigFileSettings,
): {
  sources: ResolvedConfigFileSource[];
  files: ConfigFileSourceResult[];
  warnings: string[];
  errors: string[];
} {
  const sources: ResolvedConfigFileSource[] = [];
  const files: ConfigFileSourceResult[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  if (settings.globalConfigFile !== false) {
    const resolved = resolveGlobalConfigPath(settings.globalConfigFile);
    if (resolved.ok) {
      sources.push({
        kind: "global",
        label: "global config file",
        path: resolved.path,
        explicit: settings.globalConfigFile !== undefined,
      });
    } else {
      const sourceErrors = [resolved.error];
      files.push({
        kind: "global",
        loaded: false,
        errors: sourceErrors,
      });
      errors.push(...sourceErrors);
    }
  }

  if (settings.projectConfigFile !== false) {
    if (settings.projectConfigFile === undefined && baseDir === undefined) {
      files.push({ kind: "project", loaded: false, errors: [] });
      warnings.push(
        "Project config file skipped because configFileBaseDir is unavailable. Set projectConfigFile:false to opt out explicitly.",
      );
      return { sources, files, warnings, errors };
    }

    const resolved = resolveProjectConfigPath(
      baseDir,
      settings.projectConfigFile,
    );
    if (resolved.ok && resolved.path !== undefined) {
      sources.push({
        kind: "project",
        label: "project config file",
        path: resolved.path,
        explicit: settings.projectConfigFile !== undefined,
      });
    } else if (!resolved.ok) {
      const sourceErrors = [resolved.error];
      files.push({
        kind: "project",
        loaded: false,
        errors: sourceErrors,
      });
      errors.push(...sourceErrors);
    }
  }

  return { sources, files, warnings, errors };
}

function resolveGlobalConfigPath(
  configFile: string | undefined,
): { ok: true; path: string } | { ok: false; error: string } {
  if (configFile === undefined) {
    return getDefaultGlobalConfigPath();
  }

  const expanded = expandTilde(configFile);
  if (!expanded.ok) {
    return expanded;
  }
  if (isAbsolute(expanded.path)) {
    return { ok: true, path: expanded.path };
  }

  return {
    ok: false,
    error: `globalConfigFile must be absolute or start with ~/: ${configFile}`,
  };
}

function resolveProjectConfigPath(
  baseDir: string | undefined,
  configFile: string | undefined,
): { ok: true; path?: string } | { ok: false; error: string } {
  if (configFile === undefined && baseDir === undefined) {
    return { ok: true };
  }

  const expanded = expandTilde(configFile ?? defaultSessionJanitorConfigFile);
  if (!expanded.ok) {
    return expanded;
  }

  const path = expanded.path;
  if (isAbsolute(path)) {
    return { ok: true, path };
  }
  if (baseDir === undefined) {
    return {
      ok: false,
      error: `projectConfigFile must be absolute when configFileBaseDir is unavailable: ${configFile}`,
    };
  }

  return { ok: true, path: resolve(baseDir, path) };
}

async function loadSingleConfigFile(
  source: ResolvedConfigFileSource,
): Promise<LoadedConfigFile> {
  const configPath = source.path;

  try {
    const content = await readFile(configPath, "utf8");
    const parsed = parseJsonConfig(content, configPath);
    if (parsed.ok === false) {
      return { loaded: false, errors: [parsed.error] };
    }
    if (!isRecord(parsed.value) || Array.isArray(parsed.value)) {
      return {
        loaded: false,
        errors: [`Config file must contain a JSON object: ${configPath}`],
      };
    }
    return {
      loaded: true,
      options: parsed.value as Record<string, unknown>,
      errors: [],
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT" && !source.explicit) {
      return { loaded: false, errors: [] };
    }

    return {
      loaded: false,
      errors: [
        `Failed to read ${source.label} ${configPath}: ${formatError(error)}`,
      ],
    };
  }
}

function getPrimaryConfigPath(
  files: ConfigFileSourceResult[],
): string | undefined {
  const loaded = files.filter((file) => file.loaded && file.path !== undefined);
  if (loaded.length === 1) {
    return loaded[0]?.path;
  }

  return undefined;
}

function getDefaultGlobalConfigPath():
  { ok: true; path: string } | { ok: false; error: string } {
  const configHome = getDefaultConfigHome();
  if (!configHome.ok) {
    return configHome;
  }

  return {
    ok: true,
    path: join(configHome.path, "opencode", "session-janitor.json"),
  };
}

function getDefaultConfigHome():
  { ok: true; path: string } | { ok: false; error: string } {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome === undefined) {
    const home = resolveHomeDir();
    if (!home.ok) {
      return home;
    }

    return { ok: true, path: join(home.path, ".config") };
  }
  if (xdgConfigHome.trim().length === 0 || !isAbsolute(xdgConfigHome)) {
    return {
      ok: false,
      error: `XDG_CONFIG_HOME must be absolute when set: ${xdgConfigHome}`,
    };
  }

  return { ok: true, path: xdgConfigHome };
}

function expandTilde(
  path: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (path === "~") {
    return resolveHomeDir();
  }
  if (path.startsWith("~/")) {
    const home = resolveHomeDir();
    if (!home.ok) {
      return home;
    }

    return { ok: true, path: join(home.path, path.slice(2)) };
  }

  return { ok: true, path };
}

function resolveHomeDir():
  { ok: true; path: string } | { ok: false; error: string } {
  const home = homedir();
  if (home.trim().length === 0 || !isAbsolute(home)) {
    return {
      ok: false,
      error: `Home directory must resolve to an absolute path: ${home}`,
    };
  }

  return { ok: true, path: home };
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
