/**
 * @domain subdomain: Agent Checks
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: application
 * @domain emits: agent:check_run
 * @domain depends: CheckToolchain, CheckRunner, AgentJobManager
 *
 * `funny_run_checks` on the `funny` MCP server: the agent names a kind of
 * check, funny picks the project's command, runs it with live progress for
 * the thread's widget and answers with a summary instead of the log. With
 * `background: true` the run is a durable job (`funny_spawn`'s guarantees)
 * that wakes the agent with the summary.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WSEvent } from '@funny/shared';
import { checkInputKey } from '@funny/shared/checks';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import type { AgentToolDefinition, AgentToolResult } from '../agent-mcp-http.js';
import { getServices } from '../service-registry.js';
import { resolveThreadCwd, tmpAssetsPathFor } from '../thread-context.js';
import { wsBroker } from '../ws-broker.js';
import { runCheck } from './runner.js';
import { summarizeCheckRun } from './summary.js';
import { planCheck, type CheckPlan, type CheckRequest } from './toolchain.js';

const NS = 'checks';

/**
 * A synchronous run's budget. The MCP listener has no idle cutoff for tool
 * calls and funny raises Codex's MCP tool timeout to match (core
 * `codex-mcp.ts`), so this is the only limit; longer runs go in the background.
 */
const SYNC_TIMEOUT_MS = 30 * 60_000;

const CHECK_KINDS = ['test', 'typecheck', 'lint', 'format', 'build', 'verify'] as const;

export const CHECK_INSTRUCTIONS =
  'Run tests, type checks, linters, formatters and builds with ' +
  'mcp__funny__funny_run_checks instead of Bash (e.g. not `npx vitest`, `tsc`, ' +
  "`bun run lint`): it picks the project's command, shows live progress in the " +
  'thread, and returns a short summary (failures as file:line) instead of the ' +
  'full log. Pass `command` for a custom invocation, and `background: true` ' +
  'for runs that may take more than a few minutes.';

const description =
  "Run the project's tests, type check, lint, format or build, and get a " +
  'compact summary: totals and failures as file:line with their message ' +
  '(the output tail only when a failure reported none). funny picks the ' +
  'command from the project (its package.json scripts, else the installed ' +
  'tool: vitest, jest, bun test, playwright, pytest, tsc, mypy, oxlint, ' +
  'eslint, ruff, prettier, oxfmt, cargo, go) and shows its progress live in ' +
  'the thread. `format` rewrites files (it runs the formatter in write ' +
  'mode). `verify` runs lint + typecheck + test. Runs longer than 30 minutes ' +
  'are stopped unless `background: true`, which runs them as a durable job ' +
  'and wakes you with the summary when they finish.';

const schema = {
  kind: z.enum(CHECK_KINDS).describe('What to run.'),
  scope: z
    .array(z.string())
    .optional()
    .describe('Files, directories, packages or test patterns to limit the run to.'),
  filter: z.string().optional().describe('Test name filter (vitest/jest -t, pytest -k, go -run).'),
  command: z
    .string()
    .optional()
    .describe('Exact shell command to run instead of the detected one; still instrumented.'),
  background: z
    .boolean()
    .optional()
    .describe('Run as a durable background job and wake me with the summary when it ends.'),
};

type Args = z.infer<z.ZodObject<typeof schema>>;

const text = (body: string, isError = false): AgentToolResult => ({
  content: [{ type: 'text', text: body }],
  ...(isError ? { isError: true } : {}),
});

/** The thread's working directory (its worktree, project or scratch dir). */
async function threadCwd(threadId: string): Promise<string | null> {
  const thread = await getServices().threads.getThread(threadId);
  if (!thread) return null;
  const project = thread.projectId
    ? await getServices().projects.getProject(thread.projectId)
    : null;
  const cwd = resolveThreadCwd(
    thread as unknown as Parameters<typeof resolveThreadCwd>[0],
    project ? { path: project.path } : null,
  );
  return cwd.isOk() ? cwd.value : null;
}

/** Where a run's progress file goes: the user's previewable-assets dir. */
function progressPathFor(userId: string, runId: string): string {
  const dir = join(tmpAssetsPathFor(userId), 'checks');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${runId}.json`);
}

function announce(
  userId: string,
  threadId: string,
  data: Extract<WSEvent, { type: 'agent:check_run' }>['data'],
): void {
  wsBroker.emitToUser(userId, { type: 'agent:check_run', threadId, data });
}

const here = import.meta.dir ?? dirname(fileURLToPath(import.meta.url));

/** The background runner: `run-cli.ts` in source, `run-cli.js` in the bundle. */
function cliPath(): string {
  const bundled = join(here, 'run-cli.js');
  return existsSync(bundled) ? bundled : join(here, 'run-cli.ts');
}

/** Starts the plan as a durable job running `run-cli`, which prints only the summary. */
async function startInBackground(
  threadId: string,
  userId: string,
  plan: CheckPlan,
  progressPath: string,
): Promise<AgentToolResult> {
  const spec = `${progressPath.replace(/\.json$/, '')}.plan.json`;
  writeFileSync(spec, JSON.stringify({ plan, progressPath }), { mode: 0o600 });
  const { spawnJob } = await import('../agent-job-manager.js');
  const job = await spawnJob({
    threadId,
    userId,
    command: `'${process.execPath}' '${cliPath()}' '${spec}'`,
    cwd: plan.cwd,
    label: `check ${plan.kind}`,
  });
  return text(
    `Started ${plan.kind} in the background (job ${job.id}): ` +
      `${plan.steps.map((step) => step.command).join(' ; ')}\n` +
      `I'll wake you with the summary when it finishes. You can end your turn now.\n` +
      `progressPath: ${progressPath}`,
  );
}

/** Runs `funny_run_checks` for the thread; `signal` is the MCP request's. */
async function runChecks(
  threadId: string,
  userId: string,
  args: Args,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult> {
  const cwd = await threadCwd(threadId);
  if (!cwd) return text('Could not resolve the thread working directory.', true);
  const request: CheckRequest = {
    kind: args.kind,
    ...(args.scope?.length ? { scope: args.scope } : {}),
    ...(args.filter ? { filter: args.filter } : {}),
    ...(args.command ? { command: args.command } : {}),
  };
  const planned = planCheck(cwd, request);
  if (planned.isErr()) return text(planned.error.message, true);
  const plan = planned.value;

  const runId = nanoid(10);
  const progressPath = progressPathFor(userId, runId);
  const inputKey = checkInputKey(args);
  announce(userId, threadId, {
    runId,
    kind: plan.kind,
    path: progressPath,
    inputKey,
    startedAt: Date.now(),
  });
  log.info('check run started', {
    namespace: NS,
    threadId,
    kind: plan.kind,
    background: Boolean(args.background),
    tools: plan.steps.map((step) => step.tool).join(','),
  });

  if (args.background) return startInBackground(threadId, userId, plan, progressPath);
  const result = await runCheck(plan, { progressPath, signal, timeoutMs: SYNC_TIMEOUT_MS });
  log.info('check run finished', {
    namespace: NS,
    threadId,
    kind: plan.kind,
    exitCode: result.exitCode,
    durationMs: Math.round(result.durationMs),
    stopped: result.stopped,
  });
  return text(summarizeCheckRun(plan, result, progressPath));
}

/** The `funny_run_checks` tool, bound to one spawn's thread and user. */
export function checkToolDefinition(threadId: string, userId: string): AgentToolDefinition {
  return {
    name: 'funny_run_checks',
    description,
    schema,
    run: (args: Args, extra: unknown) =>
      runChecks(threadId, userId, args, (extra as { signal?: AbortSignal } | undefined)?.signal),
  };
}
