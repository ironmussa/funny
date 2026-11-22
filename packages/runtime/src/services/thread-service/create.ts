/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created
 */
/**
 * Thread creation entry point. Each variant lives in its own module:
 * backlog threads (`create-idle.ts`), `!cmd` shell escapes
 * (`create-shell-escape.ts`), new worktrees (`create-worktree.ts`), local /
 * existing-worktree threads (`create-local.ts`, with remote containers in
 * `create-remote-container.ts`) and scratch threads (`create-scratch.ts`).
 */

import { ResultAsync } from 'neverthrow';

import { resolveProjectThreadContext, type CreateAndStartThreadParams } from './create-context.js';
import { createLocalThread } from './create-local.js';
import { createAndStartScratchThread } from './create-scratch.js';
import { createShellEscapeProjectThread } from './create-shell-escape.js';
import { createNewWorktreeThread } from './create-worktree.js';
import { ThreadServiceError, releaseStagedUploadsOnSuccess } from './helpers.js';
import { extractShellEscapeCommand } from './shell-escape.js';

export { createIdleThread, type CreateIdleThreadParams } from './create-idle.js';
export type { CreateAndStartThreadParams } from './create-context.js';

export function createAndStartThread(
  params: CreateAndStartThreadParams,
): ResultAsync<Awaited<ReturnType<typeof createAndStartThreadImpl>>, ThreadServiceError> {
  return ResultAsync.fromPromise(createAndStartThreadImpl(params), (err) =>
    err instanceof ThreadServiceError ? err : new ThreadServiceError(String(err), 500),
  ).map(releaseStagedUploadsOnSuccess(params));
}

async function createAndStartThreadImpl(params: CreateAndStartThreadParams) {
  if (params.isScratch) {
    return createAndStartScratchThread(params);
  }
  const ctx = await resolveProjectThreadContext(params);

  const shellCommand = extractShellEscapeCommand(params.prompt);
  if (shellCommand !== null) {
    return createShellEscapeProjectThread(ctx, shellCommand);
  }

  // ── Worktree mode (new worktree) ──────────────────────────────
  if (params.mode === 'worktree' && !params.worktreePath) {
    return createNewWorktreeThread(ctx);
  }

  // ── Non-worktree paths (local mode, or reusing an existing worktree) ──
  return createLocalThread(ctx);
}
