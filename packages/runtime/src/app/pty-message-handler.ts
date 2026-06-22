import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'path';

import { WORKTREE_DIR_NAME } from '@funny/core/git';

import { log } from '../lib/logger.js';
import * as ptyManager from '../services/pty-manager.js';
import { getServices } from '../services/service-registry.js';
import { scratchPathFor } from '../services/thread-context.js';
import * as tm from '../services/thread-manager.js';

/**
 * Routes incoming PTY-related WS messages (spawn / write / resize / kill /
 * signal / restore) to the PTY manager. Pulled out of app.ts so the
 * bootstrap file doesn't import path utilities, WORKTREE_DIR_NAME, or
 * pty-manager directly.
 *
 * Note: `pty:list` is handled out-of-band as an ack-based RPC on the runner
 * socket (see `central:pty_list` in `team-client.ts`) — not through this
 * generic forward channel.
 */
export function handlePtyMessage(
  type: string,
  data: any,
  userId: string,
  send: (msg: any) => void,
): void {
  // Security CR-2: every non-spawn op must verify the caller owns the
  // session. Previously only `pty:spawn` checked the user against the
  // project allow-list — `write`, `resize`, `kill`, `signal`, and `restore`
  // accepted any `data.id`, which let an authenticated user inject input
  // into another tenant's running shell or read their scrollback.
  const requireOwnership = (op: string): boolean => {
    const ptyId = typeof data?.id === 'string' ? data.id : '';
    if (!ptyId) {
      log.warn('PTY op missing id — dropping', { namespace: 'ws', op, userId });
      return false;
    }
    if (!ptyManager.assertSessionAccess(ptyId, userId)) {
      log.warn('PTY op denied: session not owned by user', {
        namespace: 'ws',
        op,
        ptyId,
        userId,
      });
      return false;
    }
    return true;
  };

  switch (type) {
    case 'pty:spawn':
      handlePtySpawn(data, userId, send);
      break;
    case 'pty:write':
      if (!requireOwnership('pty:write')) break;
      ptyManager.writePty(data.id, data.data);
      break;
    case 'pty:resize':
      if (!requireOwnership('pty:resize')) break;
      ptyManager.resizePty(data.id, data.cols, data.rows);
      break;
    case 'pty:kill':
      if (!requireOwnership('pty:kill')) break;
      ptyManager.killPty(data.id);
      break;
    case 'pty:signal':
      if (!requireOwnership('pty:signal')) break;
      handlePtySignal(data);
      break;
    case 'pty:restore':
      if (!requireOwnership('pty:restore')) break;
      handlePtyRestore(data, send);
      break;
    default:
      log.warn(`Unknown message type: ${type}`, { namespace: 'ws' });
  }
}

function handlePtySpawn(data: any, userId: string, send: (msg: any) => void): void {
  log.info('pty:spawn received', {
    namespace: 'ws',
    ptyId: data.id,
    projectId: data.projectId,
    scratchThreadId: data.scratchThreadId,
    userId,
  });

  const sendError = (error: string) => {
    send({ type: 'pty:error', data: { ptyId: data.id, error } });
  };

  // Scratch path: the client passes `scratchThreadId` instead of a real cwd
  // (the runner is the only side that knows `homedir()` + userId). Validate
  // ownership against the thread record, then mkdir + spawn in the scratch
  // dir. No project lookup involved.
  if (data.scratchThreadId) {
    const scratchThreadId: string = data.scratchThreadId;
    (async () => {
      try {
        const thread = await tm.getThread(scratchThreadId);
        if (!thread || thread.userId !== userId || !thread.isScratch) {
          log.warn('PTY spawn denied: scratch thread not owned by user', {
            namespace: 'ws',
            scratchThreadId,
            userId,
          });
          sendError('Access denied: scratch thread not found');
          return;
        }
        const cwd = scratchPathFor(userId, scratchThreadId);
        try {
          mkdirSync(cwd, { recursive: true });
        } catch (mkErr) {
          log.error('PTY spawn failed: scratch dir mkdir error', {
            namespace: 'ws',
            error: (mkErr as Error).message,
            cwd,
            ptyId: data.id,
          });
          sendError('Failed to prepare scratch directory');
          return;
        }
        ptyManager.spawnPty(
          data.id,
          cwd,
          data.cols,
          data.rows,
          userId,
          data.shell,
          data.projectId,
          data.label,
        );
      } catch (err) {
        log.error('PTY spawn failed: scratch thread lookup error', {
          namespace: 'ws',
          error: (err as Error).message,
          scratchThreadId,
          userId,
        });
        sendError('Failed to validate scratch thread');
      }
    })();
    return;
  }

  const resolvedCwd = resolve(data.cwd);
  const isUnder = (target: string, scope: string) =>
    target === scope || target.startsWith(scope + sep);
  const isCwdAllowed = (userProjects: Array<{ path: string }>) =>
    userProjects.some((p) => {
      const projectPath = resolve(p.path);
      if (isUnder(resolvedCwd, projectPath)) return true;
      const worktreeBase = resolve(dirname(projectPath), WORKTREE_DIR_NAME, basename(projectPath));
      return isUnder(resolvedCwd, worktreeBase);
    });

  const denyAccess = () => {
    log.warn(`PTY spawn denied: cwd not in user's projects`, {
      namespace: 'ws',
      cwd: data.cwd,
      userId,
    });
    sendError('Access denied: directory not in a registered project');
  };

  const doSpawn = () => {
    ptyManager.spawnPty(
      data.id,
      data.cwd,
      data.cols,
      data.rows,
      userId,
      data.shell,
      data.projectId,
      data.label,
    );
  };

  // Fast path: validate against runner-local project cache to avoid a
  // slow (and sometimes flaky) data-channel roundtrip on every spawn.
  //
  // A cache HIT authorizes immediately. A cache MISS is NOT authoritative:
  // the cache is only warmed at startup (assignLocalProjects) and on the
  // runner's own create path, so a project created through the server-side
  // flow isn't in it yet. Denying on a miss surfaced as "Access denied:
  // directory not in a registered project" for freshly-created projects even
  // though the project exists on the server. So on a miss we fall through to
  // the authoritative server list before denying.
  import('../services/team-client.js')
    .then(({ getLocalProjects }) => {
      const cached = getLocalProjects();
      if (cached && isCwdAllowed(cached)) {
        return doSpawn();
      }

      // Cache miss (or not warm yet) — consult the authoritative server list.
      return getServices()
        .projects.listProjects(userId)
        .then((userProjects) => {
          if (!isCwdAllowed(userProjects)) return denyAccess();
          doSpawn();
        });
    })
    .catch((err) => {
      log.error('PTY spawn failed: project validation error', {
        namespace: 'ws',
        error: err,
        ptyId: data.id,
        userId,
      });
      sendError('Failed to validate project access');
    });
}

function handlePtySignal(data: any): void {
  const VALID_SIGNALS: Record<string, number> = {
    SIGINT: 2,
    SIGTERM: 15,
    SIGKILL: 9,
  };
  const sigNum = VALID_SIGNALS[data.signal];
  if (sigNum !== undefined) {
    ptyManager.signalPty(data.id, sigNum);
  } else {
    log.warn('Invalid signal requested', {
      namespace: 'ws',
      signal: data.signal,
      ptyId: data.id,
    });
  }
}

function handlePtyRestore(data: any, send: (msg: any) => void): void {
  ptyManager.capturePaneAsync(data.id).then((captured) => {
    // Always respond — even with empty string — so the client exits loading state.
    send({
      type: 'pty:data',
      threadId: '',
      data: { ptyId: data.id, data: captured ?? '' },
    });
  });
}
