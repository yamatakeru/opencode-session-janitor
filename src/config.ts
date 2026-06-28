export type SessionJanitorTrigger = "startup" | "sessionIdle";

export type SessionJanitorConfig = {
  retentionDays?: number;
  dryRun?: boolean;
  includeShared?: boolean;
  excludeCurrentSession?: boolean;
  maxDeleteCount?: number | "unlimited";
  trigger?: SessionJanitorTrigger;
  allowAutoDelete?: boolean;
};

export type SessionJanitorPluginOptions = SessionJanitorConfig & {
  configFile?: string | false;
};

export type ResolvedSessionJanitorConfig = Required<SessionJanitorConfig>;

export const defaultSessionJanitorConfig = {
  retentionDays: 30,
  dryRun: true,
  includeShared: false,
  excludeCurrentSession: true,
  maxDeleteCount: 10,
  trigger: "startup",
  allowAutoDelete: false,
} satisfies ResolvedSessionJanitorConfig;

export type ConfigValidationResult =
  | {
      ok: true;
      config: ResolvedSessionJanitorConfig;
      warnings: string[];
    }
  | {
      ok: false;
      errors: string[];
      warnings: string[];
    };

const configKeys = [
  "retentionDays",
  "dryRun",
  "includeShared",
  "excludeCurrentSession",
  "maxDeleteCount",
  "trigger",
  "allowAutoDelete",
] as const;

const configKeySet = new Set<string>(configKeys);
const triggers = new Set<string>(["startup", "sessionIdle"]);

export function resolveConfig(pluginOptions?: unknown): ConfigValidationResult {
  return resolveConfigFromSources(undefined, pluginOptions);
}

export function resolveConfigFromSources(
  configFileOptions?: unknown,
  pluginOptions?: unknown,
): ConfigValidationResult {
  const merged: Record<string, unknown> = { ...defaultSessionJanitorConfig };
  const warnings: string[] = [];
  const errors: string[] = [];

  applyOptions(merged, warnings, errors, "config file", configFileOptions);
  applyOptions(merged, warnings, errors, "plugin options", pluginOptions);

  if (!isPositiveInteger(merged.retentionDays)) {
    errors.push("retentionDays must be a positive integer");
  }
  if (typeof merged.dryRun !== "boolean") {
    errors.push("dryRun must be boolean");
  }
  if (typeof merged.includeShared !== "boolean") {
    errors.push("includeShared must be boolean");
  }
  if (typeof merged.excludeCurrentSession !== "boolean") {
    errors.push("excludeCurrentSession must be boolean");
  }
  if (!isMaxDeleteCount(merged.maxDeleteCount)) {
    errors.push('maxDeleteCount must be a positive integer or "unlimited"');
  }
  if (typeof merged.trigger !== "string" || !triggers.has(merged.trigger)) {
    errors.push("trigger must be one of startup or sessionIdle");
  }
  if (typeof merged.allowAutoDelete !== "boolean") {
    errors.push("allowAutoDelete must be boolean");
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  return {
    ok: true,
    config: {
      retentionDays: merged.retentionDays,
      dryRun: merged.dryRun,
      includeShared: merged.includeShared,
      excludeCurrentSession: merged.excludeCurrentSession,
      maxDeleteCount: merged.maxDeleteCount,
      trigger: merged.trigger,
      allowAutoDelete: merged.allowAutoDelete,
    } as ResolvedSessionJanitorConfig,
    warnings,
  };
}

export function getCleanupOptions(value: unknown): unknown {
  if (
    value === undefined ||
    value === null ||
    !isRecord(value) ||
    Array.isArray(value)
  ) {
    return value;
  }

  const { configFile: _configFile, ...cleanupOptions } = value;
  return cleanupOptions;
}

function applyOptions(
  target: Record<string, unknown>,
  warnings: string[],
  errors: string[],
  label: string,
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }
  if (value === null || !isRecord(value) || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }

  for (const [key, optionValue] of Object.entries(value)) {
    if (!configKeySet.has(key)) {
      warnings.push(`Unknown ${label} key ignored: ${key}`);
      continue;
    }
    if (optionValue !== undefined) {
      target[key] = optionValue;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isMaxDeleteCount(value: unknown): value is number | "unlimited" {
  return value === "unlimited" || isPositiveInteger(value);
}
