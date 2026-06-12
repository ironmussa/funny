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

import { log } from '../lib/logger.js';
import { spawnJob } from './agent-job-manager.js';
import { createOrReschedule } from './agent-watcher-manager.js';
import { getThread } from './thread-manager.js';
import { createAndStartThread } from './thread-service/create.js';

const WATCH_INSTRUCTIONS =
  'For long-running work you have two tools. To LAUNCH a long process (build, ' +
  'test run, deploy, training, etc.), use funny_spawn — it runs the command ' +
  'detached so it survives your turn ending and is NOT killed when the harness ' +
  'reaps background jobs (a plain "cmd &" WILL be killed within minutes); funny ' +
  'then wakes you when it finishes, with the exit code and log tail. To just ' +
  'wait and re-check something yourself later, use funny_watch to schedule a ' +
  'wake. Either way, do NOT just say "I\'ll check back in N minutes" and end ' +
  'your turn — nothing will bring you back unless you call one of these tools. ' +
  'To delegate a subtask into its OWN independent thread (it runs in parallel ' +
  'with its own agent and conversation), use funny_spawn_thread — the new ' +
  'thread starts in the same project on the SAME current branch by default and ' +
  'begins working on the prompt you give it immediately. Only pass ' +
  'mode:"worktree" when the user explicitly wants the subtask on its own ' +
  'isolated branch.';

/** Args the model supplies to `funny_spawn_thread`. */
export interface SpawnThreadArgs {
  title: string;
  prompt: string;
  mode?: 'local' | 'worktree';
  model?: 'haiku' | 'sonnet' | 'opus';
}

/**
 * Core of the `funny_spawn_thread` tool, factored out so it is unit-testable
 * without going through the SDK MCP server wrapper.
 *
 * Security invariant: `parentThreadId` and `userId` come from the spawn's
 * closure — NEVER from the model. The child's `projectId` / scratch-ness is
 * read from the parent row in the DB, and the closure `userId` is what we pass
 * to `createAndStartThread`, so a thread can only ever spawn siblings for its
 * own owner (runner isolation holds for free).
 */
export async function spawnThreadForAgent(
  parentThreadId: string,
  userId: string,
  args: SpawnThreadArgs,
): Promise<
  { ok: true; childId: string; mode: 'local' | 'worktree' } | { ok: false; error: string }
> {
  const parent = await getThread(parentThreadId);
  if (!parent) {
    return { ok: false, error: `parent thread ${parentThreadId} was not found` };
  }

  const isScratch = !!parent.isScratch;
  const projectId = parent.projectId || null;
  if (!isScratch && !projectId) {
    return { ok: false, error: 'parent thread has no project' };
  }

  // Default to 'local' (run on the parent's current branch — no new branch
  // unless the user explicitly asks for worktree). Scratch threads are always
  // local (no git/worktree).
  const mode: 'local' | 'worktree' = isScratch ? 'local' : (args.mode ?? 'local');

  const result = await createAndStartThread({
    projectId,
    userId,
    title: args.title,
    prompt: args.prompt,
    mode,
    model: args.model,
    source: 'agent-spawn',
    parentThreadId,
    isScratch,
  });

  if (result.isErr()) {
    log.warn('funny_spawn_thread failed', {
      namespace: 'agent',
      parentThreadId,
      userId,
      error: result.error.message,
    });
    return { ok: false, error: result.error.message };
  }

  log.info('funny_spawn_thread created child thread', {
    namespace: 'agent',
    parentThreadId,
    childThreadId: result.value.id,
    userId,
    mode,
  });
  return { ok: true, childId: result.value.id, mode };
}

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
      tool(
        'funny_spawn_thread',
        'Create and START a new, independent thread to handle a subtask. The ' +
          'new thread runs in parallel with its own agent, conversation, and ' +
          '(in worktree mode) its own git branch — use it to fan a big task out ' +
          'into separate threads instead of doing everything in this one. The ' +
          'child starts in the SAME project as you and begins working on ' +
          '`prompt` immediately. Returns the new thread id.',
        {
          title: z
            .string()
            .describe('Short, descriptive title for the new thread (shown in the sidebar).'),
          prompt: z
            .string()
            .describe('The initial prompt / full instructions the new thread should work on.'),
          mode: z
            .enum(['local', 'worktree'])
            .optional()
            .describe(
              "local (default) runs the child on the parent's CURRENT branch — " +
                'do not create a new branch unless the user explicitly asks. ' +
                'worktree gives the child its own isolated git branch; only use ' +
                'it when the user requests isolation. Forced to local for scratch threads.',
            ),
          model: z
            .enum(['haiku', 'sonnet', 'opus'])
            .optional()
            .describe('Model for the new thread (defaults to the project default).'),
        },
        async (args) => {
          // parentThreadId + userId come from the closure, never the model.
          const result = await spawnThreadForAgent(threadId, userId, args);
          if (!result.ok) {
            return {
              content: [
                { type: 'text' as const, text: `Could not spawn a thread: ${result.error}` },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Spawned thread "${args.title}" (id ${result.childId}) in ${result.mode} mode. ` +
                  `It's running independently now — you don't need to wait for it.`,
              },
            ],
          };
        },
      ),
    ],
  });
}
