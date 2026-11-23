/**
 * A read-only agent has no network (`readOnly` in `@funny/core`), so the
 * repository is fetched for it before it starts, by the runner, with the
 * owner's GitHub token (or the git credentials of the checkout). Best effort:
 * a fetch that fails leaves the agent with what the checkout already has, and
 * it says so in the thread's log.
 */
import { detectReadOnlySandboxMode } from '@funny/core/agents';
import { fetchRemote } from '@funny/core/git';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import { getServices } from '../service-registry.js';

export async function fetchForReadOnlyAgent(input: {
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
export async function logReadOnlySandboxMode(threadId: string): Promise<void> {
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
