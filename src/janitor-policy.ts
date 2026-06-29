import type {
  ResolvedSessionJanitorConfig,
  SessionJanitorTrigger,
} from "./config.js";

const autoDeleteRequiresAllowWarning =
  "dryRun:false ignored because startup auto delete requires allowAutoDelete:true.";
const autoDeleteRequiresCurrentSessionProtectionWarning =
  "dryRun:false ignored because startup auto delete requires excludeCurrentSession:true.";
const nonStartupDryRunWarning =
  "dryRun:false ignored because automatic deletion is only supported for trigger:startup.";

export function applyAutoDeleteGate(
  config: ResolvedSessionJanitorConfig,
  warnings: string[],
  trigger: SessionJanitorTrigger,
): ResolvedSessionJanitorConfig {
  if (config.dryRun) {
    return config;
  }

  const gateWarnings = getAutoDeleteGateWarnings(config, trigger);
  if (gateWarnings.length === 0) {
    return config;
  }

  warnings.push(...gateWarnings);
  return { ...config, dryRun: true };
}

export function applyForcedDryRun(
  config: ResolvedSessionJanitorConfig,
  warnings: string[],
): ResolvedSessionJanitorConfig {
  if (config.dryRun) {
    return config;
  }

  warnings.push("dryRun:false ignored because this run was forced to dry-run.");
  return { ...config, dryRun: true };
}

export function getDeleteBlockedByWarningsErrors(warnings: string[]): string[] {
  return warnings.map(
    (warning) =>
      `Refusing delete because configuration was not fully recognized: ${warning}`,
  );
}

function getAutoDeleteGateWarnings(
  config: ResolvedSessionJanitorConfig,
  trigger: SessionJanitorTrigger,
): string[] {
  const warnings: string[] = [];

  if (trigger !== "startup") {
    warnings.push(nonStartupDryRunWarning);
  }
  if (!config.allowAutoDelete) {
    warnings.push(autoDeleteRequiresAllowWarning);
  }
  if (!config.excludeCurrentSession) {
    warnings.push(autoDeleteRequiresCurrentSessionProtectionWarning);
  }
  return warnings;
}
