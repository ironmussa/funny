import { mkdirSync } from 'node:fs';

import { syncClaudeProjectAssets } from '@funny/core/ports';
import { errorMessage } from '@funny/shared/errors';

import { log } from '../../lib/logger.js';

/** Copy Claude project assets into a worktree; failures are logged, never fatal. */
export function syncWorktreeProjectAssets(
  threadId: string,
  projectPath: string,
  worktreePath: string,
): void {
  try {
    syncClaudeProjectAssets(projectPath, worktreePath);
  } catch (err) {
    log.warn('Failed to sync Claude project assets into worktree', {
      namespace: 'agent',
      threadId,
      projectPath,
      worktreePath,
      error: errorMessage(err),
    });
  }
}

/**
 * Create a runner-owned working directory (see `hasLazyCwd` in
 * thread-context.ts) before the agent starts. Rethrows on failure.
 */
export function ensureLazyCwd(threadId: string, userId: string, cwd: string): void {
  try {
    mkdirSync(cwd, { recursive: true });
    log.info('Scratch directory ready', {
      namespace: 'scratch-threads',
      threadId,
      userId,
      cwd,
    });
  } catch (mkErr) {
    log.error('Failed to create scratch directory', {
      namespace: 'scratch-threads',
      threadId,
      cwd,
      error: errorMessage(mkErr),
    });
    throw mkErr;
  }
}
