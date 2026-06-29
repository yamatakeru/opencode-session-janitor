import type { Plugin } from "@opencode-ai/plugin";

import type { SessionJanitorPluginOptions } from "./config.js";
import { runSessionJanitor } from "./janitor.js";
import {
  getStartupAutoDeleteConfig,
  matchesForcedDryRunConfig,
} from "./plugin-startup-config.js";
import {
  isStartupLoggingFailure,
  reportStartupAutoDeleteBlocked,
  reportStartupError,
  reportStartupResultProblems,
  scheduleDelayedStartupToast,
} from "./plugin-startup-logging.js";

type TrustedSessionSource = "chat.message" | "command.execute.before";
type TrustedStartupSessionObservation = {
  trustedSessionID: string;
  trustedSessionSource: TrustedSessionSource;
};

const SessionJanitorPlugin: Plugin = async function SessionJanitorPlugin(
  input,
  options,
) {
  const pluginOptions = options as SessionJanitorPluginOptions | undefined;
  let autoDeleteStarted = false;
  let autoDeleteBlocked = false;
  let autoDeleteRunCompleted = false;
  let autoDeleteAbortController: AbortController | undefined;
  let trustedStartupSession: TrustedStartupSessionObservation | undefined;
  const startupDryRun = Promise.resolve()
    .then(() =>
      runSessionJanitor({
        client: input.client,
        pluginOptions,
        configFileBaseDir: input.worktree,
        trigger: "startup",
        forceDryRun: true,
        suppressTuiToast: true,
      }),
    )
    .then((result) => {
      reportStartupResultProblems("dry-run", result);
      scheduleDelayedStartupToast(input.client, result.metadata);
      return result;
    })
    .catch((error: unknown) => {
      void reportStartupError("dry-run", input.client, error);
      return undefined;
    });

  void startupDryRun;

  function observeTrustedStartupSession({
    trustedSessionID,
    trustedSessionSource,
  }: TrustedStartupSessionObservation): void {
    const normalizedTrustedSessionID = trustedSessionID.trim();

    if (normalizedTrustedSessionID.length === 0) {
      return;
    }
    if (normalizedTrustedSessionID !== trustedSessionID) {
      blockStartupAutoDeleteFromTrustedSession({
        trustedSessionSource,
        errors: [
          "Refusing startup auto delete because trusted sessionID was not normalized.",
        ],
      });
      return;
    }

    const observation = {
      trustedSessionID: normalizedTrustedSessionID,
      trustedSessionSource,
    };

    if (
      trustedStartupSession &&
      trustedStartupSession.trustedSessionID !== observation.trustedSessionID
    ) {
      if (!autoDeleteRunCompleted) {
        blockStartupAutoDeleteFromTrustedSession({
          trustedSessionSource,
          errors: [
            "Refusing startup auto delete because multiple trusted session hooks reported different session IDs.",
          ],
          extra: {
            firstTrustedSessionSource:
              trustedStartupSession.trustedSessionSource,
            conflictingTrustedSessionSource: trustedSessionSource,
          },
        });
      }
      return;
    }

    if (autoDeleteStarted) {
      return;
    }

    trustedStartupSession = observation;
    autoDeleteStarted = true;
    void startStartupAutoDeleteFromTrustedSession(observation).catch(
      (error: unknown) => {
        void reportStartupError("auto delete", input.client, error, {
          autoDeleteTrigger: "startup-armed",
          trustedSessionSource,
        });
      },
    );
  }

  async function startStartupAutoDeleteFromTrustedSession({
    trustedSessionID,
    trustedSessionSource,
  }: TrustedStartupSessionObservation): Promise<void> {
    const blockLogMetadata =
      getTrustedStartupAutoDeleteMetadata(trustedSessionSource);

    try {
      const dryRunResult = await startupDryRun;
      if (autoDeleteBlocked) {
        return;
      }
      if (dryRunResult?.metadata.ok !== true) {
        return;
      }
      const dryRunLogging = dryRunResult.metadata.logging;
      if (isStartupLoggingFailure(dryRunLogging)) {
        await reportStartupAutoDeleteBlocked(
          input.client,
          {
            kind: "blocked",
            errors: [
              `Refusing startup auto delete because the startup dry-run could not be logged: ${dryRunLogging.error}`,
            ],
            warnings: [],
          },
          blockLogMetadata,
        );
        return;
      }

      const autoDeleteConfig = await getStartupAutoDeleteConfig({
        pluginOptions,
        configFileBaseDir: input.worktree,
      });
      if (autoDeleteConfig.kind === "blocked") {
        await reportStartupAutoDeleteBlocked(
          input.client,
          autoDeleteConfig,
          blockLogMetadata,
        );
        return;
      }
      if (autoDeleteConfig.kind !== "ready") {
        return;
      }
      if (
        !matchesForcedDryRunConfig(
          dryRunResult.metadata.config,
          autoDeleteConfig.config,
        )
      ) {
        await reportStartupAutoDeleteBlocked(
          input.client,
          {
            kind: "blocked",
            errors: [
              "Refusing startup auto delete because config changed after the startup dry-run.",
            ],
            warnings: [],
          },
          blockLogMetadata,
        );
        return;
      }
      if (autoDeleteBlocked) {
        return;
      }

      const abortController = new AbortController();
      autoDeleteAbortController = abortController;
      const result = await runSessionJanitor({
        client: input.client,
        pluginOptions: {
          ...autoDeleteConfig.config,
          globalConfigFile: false,
          projectConfigFile: false,
        },
        configFileBaseDir: input.worktree,
        currentSessionID: trustedSessionID,
        trigger: "startup",
        abortSignal: abortController.signal,
      });
      reportStartupResultProblems("auto delete", result);
    } finally {
      autoDeleteRunCompleted = true;
    }
  }

  function blockStartupAutoDeleteFromTrustedSession({
    trustedSessionSource,
    errors,
    extra = {},
  }: {
    trustedSessionSource: TrustedSessionSource;
    errors: string[];
    extra?: Record<string, unknown>;
  }): void {
    if (autoDeleteBlocked) {
      return;
    }

    autoDeleteBlocked = true;
    autoDeleteStarted = true;
    autoDeleteAbortController?.abort();
    const metadata = getTrustedStartupAutoDeleteMetadata(
      trustedSessionSource,
      extra,
    );
    void reportStartupAutoDeleteBlocked(
      input.client,
      {
        kind: "blocked",
        errors,
        warnings: [],
      },
      metadata,
    ).catch((error: unknown) => {
      void reportStartupError("auto delete", input.client, error, metadata);
    });
  }

  return {
    "chat.message": async (hookInput) => {
      observeTrustedStartupSession({
        trustedSessionID: hookInput.sessionID,
        trustedSessionSource: "chat.message",
      });
    },
    "command.execute.before": async (hookInput) => {
      observeTrustedStartupSession({
        trustedSessionID: hookInput.sessionID,
        trustedSessionSource: "command.execute.before",
      });
    },
  };
};

function getTrustedStartupAutoDeleteMetadata(
  trustedSessionSource: TrustedSessionSource,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    autoDeleteTrigger: "startup-armed",
    trustedSessionSource,
    ...extra,
  };
}

export default SessionJanitorPlugin;
