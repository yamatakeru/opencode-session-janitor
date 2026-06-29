import {
  getCleanupOptions,
  resolveConfigFromOptionSources,
  type ResolvedSessionJanitorConfig,
  type SessionJanitorPluginOptions,
} from "./config.js";
import { loadSessionJanitorConfigFile } from "./config-file.js";
import { getDeleteBlockedByWarningsErrors } from "./janitor-policy.js";

export type StartupAutoDeleteConfigResult =
  | { kind: "ready"; config: ResolvedSessionJanitorConfig }
  | { kind: "not-enabled" }
  | { kind: "blocked"; errors: string[]; warnings: string[] };

export async function getStartupAutoDeleteConfig(input: {
  pluginOptions: SessionJanitorPluginOptions | undefined;
  configFileBaseDir: string;
}): Promise<StartupAutoDeleteConfigResult> {
  const configFile = await loadSessionJanitorConfigFile({
    baseDir: input.configFileBaseDir,
    pluginOptions: input.pluginOptions,
  });
  if (configFile.errors.length > 0) {
    return {
      kind: "blocked",
      errors: configFile.errors,
      warnings: configFile.warnings,
    };
  }

  const validation = resolveConfigFromOptionSources(
    configFile.optionSources,
    getCleanupOptions(input.pluginOptions),
  );
  if (!validation.ok) {
    return {
      kind: "blocked",
      errors: validation.errors,
      warnings: [...configFile.warnings, ...validation.warnings],
    };
  }

  const warnings = [...configFile.warnings, ...validation.warnings];
  const startupAutoDeleteEnabled =
    validation.config.trigger === "startup" &&
    validation.config.dryRun === false &&
    validation.config.allowAutoDelete === true;

  if (!startupAutoDeleteEnabled) {
    return { kind: "not-enabled" };
  }

  if (warnings.length > 0) {
    return {
      kind: "blocked",
      errors: getDeleteBlockedByWarningsErrors(warnings),
      warnings,
    };
  }

  const gateErrors = getStartupAutoDeleteProtectionErrors(validation.config);
  if (gateErrors.length > 0) {
    return { kind: "blocked", errors: gateErrors, warnings: [] };
  }

  return { kind: "ready", config: validation.config };
}

export function matchesForcedDryRunConfig(
  dryRunConfig: unknown,
  autoDeleteConfig: ResolvedSessionJanitorConfig,
): boolean {
  if (typeof dryRunConfig !== "object" || dryRunConfig === null) {
    return false;
  }

  const config = dryRunConfig as Partial<ResolvedSessionJanitorConfig>;
  return (
    config.retentionDays === autoDeleteConfig.retentionDays &&
    config.dryRun === true &&
    config.includeShared === autoDeleteConfig.includeShared &&
    config.excludeCurrentSession === autoDeleteConfig.excludeCurrentSession &&
    config.maxDeleteCount === autoDeleteConfig.maxDeleteCount &&
    config.trigger === autoDeleteConfig.trigger &&
    config.allowAutoDelete === autoDeleteConfig.allowAutoDelete &&
    config.notifyTui === autoDeleteConfig.notifyTui
  );
}

function getStartupAutoDeleteProtectionErrors(
  config: ResolvedSessionJanitorConfig,
): string[] {
  const errors: string[] = [];

  if (!config.excludeCurrentSession) {
    errors.push(
      "Refusing startup auto delete because excludeCurrentSession:true is required.",
    );
  }

  return errors;
}
