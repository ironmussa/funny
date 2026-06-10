/**
 * @domain subdomain: Watchers
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: application
 * @domain depends: AgentWatcherManager
 *
 * In-process MCP tool `funny_watch` exposed to the Claude Agent SDK.
 *
 * `funny_watch` is the SOLE creation path for a watcher (a deferred-wake
 * "snooze"). It is injected on every spawn with `alwaysLoad: true`, so the
 * agent can always reach it — the reliability invariant depends on it never
 * being "not configured". The handler runs in-process here, so it has the
 * spawn's `threadId`/`userId` directly and calls the watcher-manager without
 * any transport hop.
 *
 * Tool name as seen by the model: `mcp__funny__funny_watch`.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { spawnJob } from './agent-job-manager.js';
import { createOrReschedule } from './agent-watcher-manager.js';

const WATCH_INSTRUCTIONS =
  'For long-running work you have two tools. To LAUNCH a long process (build, ' +
  'test run, deploy, training, etc.), use funny_spawn — it runs the command ' +
  'detached so it survives your turn ending and is NOT killed when the harness ' +
  'reaps background jobs (a plain "cmd &" WILL be killed within minutes); funny ' +
  'then wakes you when it finishes, with the exit code and log tail. To just ' +
  'wait and re-check something yourself later, use funny_watch to schedule a ' +
  'wake. Either way, do NOT just say "I\'ll check back in N minutes" and end ' +
  'your turn — nothing will bring you back unless you call one of these tools.';

/**
 * Build the in-process `funny` MCP server bound to one spawn's thread/user.
 * Returned value is merged into the agent's `mcpServers` option.
 */
export function buildWatchMcpServer(threadId: string, userId: string) {
  return createSdkMcpServer({
    name: 'funny',
    version: '1.0.0',
    instructions: WATCH_INSTRUCTIONS,
    // Always include the tool in the prompt — never defer it behind tool search.
    alwaysLoad: true,
    tools: [
      tool(
        'funny_watch',
        'Schedule a deferred wake ("snooze") on THIS thread. funny wakes you ' +
          'after the delay so you can re-check long-running work without your ' +
          'turn having to stay open. Reuse the same `key` to reschedule/extend ' +
          'an existing watcher instead of creating a duplicate.',
        {
          key: z
            .string()
            .describe('Stable id for the thing you are watching; reuse it to reschedule/extend.'),
          label: z.string().describe('Short human-readable label shown in the UI.'),
          delayMinutes: z
            .number()
            .positive()
            .describe('Minutes to wait before waking you (clamped to a 1-minute minimum).'),
          maxWakes: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Max number of times to wake you before giving up (default 20).'),
          deadlineMinutes: z
            .number()
            .positive()
            .optional()
            .describe('Hard lifetime ceiling in minutes (default 60).'),
        },
        async (args) => {
          const watcher = await createOrReschedule({
            threadId,
            userId,
            key: args.key,
            label: args.label,
            delayMs: Math.round(args.delayMinutes * 60_000),
            maxWakes: args.maxWakes,
            deadlineMs:
              args.deadlineMinutes != null ? Math.round(args.deadlineMinutes * 60_000) : undefined,
          });
          const nextIso = new Date(watcher.nextWakeAt).toISOString();
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Scheduled watcher "${watcher.label}" (id ${watcher.id}). ` +
                  `I'll wake you at ${nextIso}. You can end your turn now — ` +
                  `you'll be re-prompted then to re-check.`,
              },
            ],
          };
        },
      ),
      tool(
        'funny_spawn',
        'Launch a long-running shell command as a durable background job on ' +
          'THIS thread. The process runs detached (its own session, reparented ' +
          'to init), so it survives your turn ending, the harness reaping ' +
          'background jobs, and a runner restart — unlike a plain `cmd &`. funny ' +
          'captures stdout/stderr to a logfile and wakes you when the job ' +
          'finishes, with the exit code and the log tail. Use this instead of ' +
          'backgrounding the command yourself.',
        {
          command: z.string().describe('The shell command to run (executed via bash -c).'),
          cwd: z
            .string()
            .optional()
            .describe('Working directory to run in (defaults to the runner cwd).'),
          label: z.string().optional().describe('Short human-readable label shown in the UI.'),
          wakeInMinutes: z
            .number()
            .positive()
            .optional()
            .describe('Also wake you mid-run after this many minutes (in addition to on finish).'),
        },
        async (args) => {
          const job = await spawnJob({
            threadId,
            userId,
            command: args.command,
            cwd: args.cwd,
            label: args.label,
            wakeInMinutes: args.wakeInMinutes,
          });
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Launched background job ${job.label ? `"${job.label}" ` : ''}(id ${job.id}, ` +
                  `pid ${job.pid}). Output → ${job.logPath}. It runs detached; ` +
                  `I'll wake you when it finishes. You can end your turn now.`,
              },
            ],
          };
        },
      ),
    ],
  });
}
