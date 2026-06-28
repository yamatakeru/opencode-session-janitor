import { tool, type Plugin } from "@opencode-ai/plugin";

import type { SessionJanitorConfig } from "./config.js";
import { runSessionJanitor } from "./janitor.js";

const toolArgs = {
  retentionDays: tool.schema
    .number()
    .int()
    .positive()
    .optional()
    .describe("Positive integer number of days to retain sessions."),
  dryRun: tool.schema
    .boolean()
    .optional()
    .describe("When true, preview only and do not delete sessions."),
  includeShared: tool.schema
    .boolean()
    .optional()
    .describe("When true, shared sessions may be candidates."),
  excludeCurrentSession: tool.schema
    .boolean()
    .optional()
    .describe("When true, protect the current session."),
  minSessionsToKeep: tool.schema
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Protect this many newest sessions."),
  maxDeleteCount: tool.schema
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of candidate sessions to delete in one run."),
};

const SessionJanitorPlugin: Plugin = async function SessionJanitorPlugin(
  input,
  options,
) {
  const pluginOptions = options as SessionJanitorConfig | undefined;

  return {
    tool: {
      session_janitor: tool({
        description:
          "Preview or manually delete old OpenCode sessions using a safe retention policy. Defaults to dry-run.",
        args: toolArgs,
        async execute(args, context) {
          const result = await runSessionJanitor({
            client: input.client,
            pluginOptions,
            toolArgs: args,
            currentSessionID: context.sessionID,
            trigger: "manual",
            abortSignal: context.abort,
          });

          return {
            title: result.title,
            output: result.output,
            metadata: result.metadata,
          };
        },
      }),
    },
  };
};

export default SessionJanitorPlugin;
