/**
 * A read-only agent has no network (`readOnly` in `@funny/core`), so the
 * repository is fetched for it before it starts, by the runner, with the
 * owner's GitHub token (or the git credentials of the checkout). Best effort:
 * a fetch that fails leaves the agent with what the checkout already has, and
 * it says so in the thread's log.
 */
import { detectReadOnlySandboxMode } from '@funny/core/agents';
import { fetchRemote } from '@funny/core/git';

import { DATA_DIR } from '../../lib/data-dir.js';
import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import type { RuntimeThreadRecord } from '../server-interfaces.js';
import { getServices } from '../service-registry.js';
import { canDoGitOps, isReadOnlyThread } from '../thread-context.js';
import { existingRoleInputsDir } from './role-inputs.js';

async function fetchForReadOnlyAgent(input: {
  threadId: string;
  cwd: string;
  userId?: string;
  projectId?: string | null;
}): Promise<void> {
  const githubToken = input.userId
    ? ((await getServices().profile.getGithubToken(input.userId, input.projectId || undefined)) ??
      undefined)
    : undefined;
  const fetched = await fetchRemote(input.cwd, githubToken ? { githubToken } : undefined);
  const ok = fetched.isOk() && fetched.value;
  metric('agent.read_only_fetch', 1, { type: 'sum', attributes: { ok: String(ok) } });
  if (!ok) {
    log.warn('Could not fetch the repository for a read-only agent', {
      namespace: 'agent',
      threadId: input.threadId,
      error: fetched.isErr() ? fetched.error.message : 'fetch failed',
    });
  }
}

/**
 * Record which sandbox a read-only Claude agent runs in on this runner
 * (`detectReadOnlySandboxMode`): `socket-denylist` is the weaker one, so it is
 * a warning, with what would make the runner strict.
 */
async function logReadOnlySandboxMode(threadId: string): Promise<void> {
  const mode = await detectReadOnlySandboxMode();
  metric('agent.read_only_sandbox', 1, { type: 'sum', attributes: { mode } });
  if (mode === 'strict') {
    log.info('Read-only agent runs in the strict sandbox', { namespace: 'agent', threadId, mode });
    return;
  }
  log.warn(
    'Read-only agent runs with Unix sockets allowed: this host refuses user namespaces nested in bubblewrap (e.g. the bwrap-userns-restrict AppArmor profile), so only the known escape sockets are hidden',
    { namespace: 'agent', threadId, mode },
  );
}

/** What a read-only start adds to the agent's environment and options. */
export interface ReadOnlyStart {
  env: Record<string, string>;
  options: { readOnly: true; readOnlyRoots?: string[]; readOnlyHiddenPaths: string[] };
}

/**
 * Get a read-only thread's start ready (`threads.read_only`; null for any
 * other thread): the repository
 * fetched for it (its agent has no network), its sandbox mode recorded, and
 * the folder of its role inputs (the issue's text) given to the agent.
 */
export async function prepareReadOnlyStart(input: {
  thread: RuntimeThreadRecord | undefined;
  threadId: string;
  cwd: string;
  userId?: string;
  provider: string;
}): Promise<ReadOnlyStart | null> {
  const { thread, threadId } = input;
  if (!thread || !isReadOnlyThread(thread)) return null;
  if (canDoGitOps(thread)) {
    await fetchForReadOnlyAgent({
      threadId,
      cwd: input.cwd,
      userId: input.userId,
      projectId: thread.projectId,
    });
  }
  if (input.provider === 'claude') await logReadOnlySandboxMode(threadId);
  // Nothing else writes this name, so the agent finds only its own inputs there.
  const roleInputs = existingRoleInputsDir(threadId);
  return {
    env: roleInputs ? { FUNNY_ROLE_INPUTS: roleInputs } : {},
    options: {
      readOnly: true,
      readOnlyRoots: roleInputs ? [roleInputs] : undefined,
      readOnlyHiddenPaths: [DATA_DIR],
    },
  };
}

/** The agent's environment with what a read-only start adds; the same object when it adds nothing. */
export function withReadOnlyEnv<E extends Record<string, string> | undefined>(
  env: E,
  start: ReadOnlyStart | null,
): E | Record<string, string> {
  if (!start || Object.keys(start.env).length === 0) return env;
  return { ...env, ...start.env };
}
