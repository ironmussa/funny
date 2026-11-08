/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: infrastructure
 * @domain emits: git:changed
 *
 * Watches `.git/` internals (index, HEAD, refs/) for external changes.
 * Per-project lifecycle: starts watching when the first thread is created,
 * stops when the last thread is deleted. On a change it emits `git:changed`
 * on the ThreadEventBus only for the threads whose git state moved, compared
 * with a gitoxide ref fingerprint (HEAD, upstream, base branch, index). A
 * commit in one worktree therefore no longer recomputes the status of every
 * thread in the project. Without native git, every registered thread is
 * notified as before.
 */

import { watch, type FSWatcher } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';

import { baseBranchRefs, getNativeGit, getRefFingerprint } from '@funny/core/git';

import { log } from '../lib/logger.js';
import { getServices } from './service-registry.js';
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
import { threadEventBus } from './thread-event-bus.js';

const DEBOUNCE_MS = 300;

interface ThreadMeta {
  userId: string;
  worktreePath: string | null;
  /** Base branch, looked up once on the first refresh (`null` when none). */
  baseBranch?: string | null;
  /** Last ref fingerprint seen; unset until the first refresh. */
  fingerprint?: string;
}

interface ProjectWatcher {
  /** Thread metadata keyed by thread ID */
  threads: Map<string, ThreadMeta>;
  /** Active FSWatcher instances */
  watchers: FSWatcher[];
  /** Debounce timer for batching rapid changes */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Project path (for resolving .git/) */
  projectPath: string;
  /** A refresh pass is computing fingerprints */
  refreshing: boolean;
  /** Another change arrived during the running refresh pass */
  refreshPending: boolean;
}

const projectWatchers = new Map<string, ProjectWatcher>();

/**
 * Start watching a project's .git/ directory for external changes.
 * If the project is already being watched, just registers the thread.
 */
export function startWatching(
  projectId: string,
  projectPath: string,
  threadId: string,
  userId: string,
  worktreePath: string | null,
): void {
  let pw = projectWatchers.get(projectId);

  if (pw) {
    pw.threads.set(threadId, { userId, worktreePath });
    log.debug(
      `Git watcher: added thread ${threadId} to project ${projectId} (${pw.threads.size} threads)`,
      {
        namespace: 'git-watcher',
      },
    );
    return;
  }

  // First thread for this project — create watchers
  pw = {
    threads: new Map([[threadId, { userId, worktreePath }]]),
    watchers: [],
    debounceTimer: null,
    projectPath,
    refreshing: false,
    refreshPending: false,
  };

  const gitDir = join(projectPath, '.git');
  if (!existsSync(gitDir)) {
    log.warn(`Git watcher: .git directory not found at ${gitDir}, skipping`, {
      namespace: 'git-watcher',
    });
    return;
  }

  const onChange = () => onGitChange(projectId);

  // Watch individual files and directories inside .git/
  const targets = [
    { path: join(gitDir, 'index'), desc: 'index' },
    { path: join(gitDir, 'HEAD'), desc: 'HEAD' },
    { path: join(gitDir, 'FETCH_HEAD'), desc: 'FETCH_HEAD' },
    { path: join(gitDir, 'refs'), desc: 'refs/' },
  ];

  for (const target of targets) {
    if (!existsSync(target.path)) continue;
    try {
      const w = watch(target.path, { recursive: target.desc === 'refs/' }, () => onChange());
      pw.watchers.push(w);
    } catch (err) {
      log.warn(`Git watcher: failed to watch ${target.desc} for project ${projectId}`, {
        namespace: 'git-watcher',
        error: err,
      });
    }
  }

  projectWatchers.set(projectId, pw);
  log.info(`Git watcher: started for project ${projectId} (${pw.watchers.length} targets)`, {
    namespace: 'git-watcher',
  });
}

/**
 * Stop watching for a specific thread. If it's the last thread,
 * closes all FSWatcher instances for the project.
 */
export function stopWatching(projectId: string, threadId: string): void {
  const pw = projectWatchers.get(projectId);
  if (!pw) return;

  pw.threads.delete(threadId);
  log.debug(
    `Git watcher: removed thread ${threadId} from project ${projectId} (${pw.threads.size} remaining)`,
    {
      namespace: 'git-watcher',
    },
  );

  if (pw.threads.size === 0) {
    closeWatcher(projectId, pw);
  }
}

/** Debounced handler for fs.watch events */
function onGitChange(projectId: string): void {
  const pw = projectWatchers.get(projectId);
  if (!pw) return;

  if (pw.debounceTimer) clearTimeout(pw.debounceTimer);

  pw.debounceTimer = setTimeout(() => {
    pw.debounceTimer = null;
    void refreshThreads(projectId, pw);
  }, DEBOUNCE_MS);
}

type ThreadEntry = [threadId: string, meta: ThreadMeta];

/**
 * Pick the threads whose fingerprint changed since the last pass and store the
 * new fingerprints. A thread whose fingerprint cannot be computed (`null`) is
 * always selected, so an error never hides a change.
 */
export async function selectChangedThreads(
  entries: ThreadEntry[],
  fingerprint: (threadId: string, meta: ThreadMeta) => Promise<string | null>,
): Promise<ThreadEntry[]> {
  const results = await Promise.all(
    entries.map(async ([threadId, meta]) => {
      const next = await fingerprint(threadId, meta);
      const changed = next === null || next !== meta.fingerprint;
      meta.fingerprint = next ?? undefined;
      return changed;
    }),
  );
  return entries.filter((_, i) => results[i]);
}

async function threadFingerprint(
  threadId: string,
  meta: ThreadMeta,
  projectPath: string,
): Promise<string | null> {
  if (meta.baseBranch === undefined) {
    try {
      const thread = await getServices().threads.getThread(threadId);
      meta.baseBranch = thread?.baseBranch ?? null;
    } catch {
      return null;
    }
  }
  const result = await getRefFingerprint(
    meta.worktreePath ?? projectPath,
    baseBranchRefs(meta.baseBranch),
  );
  return result.isOk() ? result.value : null;
}

/** Serialized refresh: changes arriving mid-pass trigger one more pass. */
async function refreshThreads(projectId: string, pw: ProjectWatcher): Promise<void> {
  if (pw.refreshing) {
    pw.refreshPending = true;
    return;
  }
  pw.refreshing = true;
  try {
    do {
      pw.refreshPending = false;
      const entries = Array.from(pw.threads.entries());
      const changed = getNativeGit()
        ? await selectChangedThreads(entries, (id, meta) =>
            threadFingerprint(id, meta, pw.projectPath),
          )
        : entries;
      if (projectWatchers.get(projectId) !== pw) return;
      emitForThreads(projectId, pw, changed, entries.length);
    } while (pw.refreshPending);
  } catch (err) {
    log.warn(`Git watcher: refresh failed for project ${projectId}`, {
      namespace: 'git-watcher',
      error: err,
    });
  } finally {
    pw.refreshing = false;
  }
}

/**
 * Emit `git:changed` for the given threads of this project watcher.
 * Staggers emissions in batches to avoid a thundering herd when projects
 * have hundreds of threads — each batch is offset by STAGGER_MS so the
 * downstream per-thread debounce timers don't all fire simultaneously.
 */
const BATCH_SIZE = 10;
const STAGGER_MS = 100;

function emitForThreads(
  projectId: string,
  pw: ProjectWatcher,
  entries: ThreadEntry[],
  registered: number,
): void {
  if (entries.length === 0) return;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const delay = (i / BATCH_SIZE) * STAGGER_MS;

    if (delay === 0) {
      // First batch — emit immediately
      for (const [threadId, meta] of batch) {
        threadEventBus.emit('git:changed', {
          threadId,
          projectId,
          userId: meta.userId,
          worktreePath: meta.worktreePath,
          cwd: meta.worktreePath ?? pw.projectPath,
          toolName: 'external',
        });
      }
    } else {
      // Subsequent batches — stagger
      setTimeout(() => {
        // Guard: project may have been unwatched while stagger timers were pending
        if (!projectWatchers.has(projectId)) return;
        for (const [threadId, meta] of batch) {
          threadEventBus.emit('git:changed', {
            threadId,
            projectId,
            userId: meta.userId,
            worktreePath: meta.worktreePath,
            cwd: meta.worktreePath ?? pw.projectPath,
            toolName: 'external',
          });
        }
      }, delay);
    }
  }

  log.debug(
    `Git watcher: emitted git:changed for ${entries.length}/${registered} thread(s) in project ${projectId} (${Math.ceil(entries.length / BATCH_SIZE)} batches)`,
    { namespace: 'git-watcher' },
  );
}

/** Close all watchers for a project and clean up */
function closeWatcher(projectId: string, pw: ProjectWatcher): void {
  if (pw.debounceTimer) {
    clearTimeout(pw.debounceTimer);
    pw.debounceTimer = null;
  }
  for (const w of pw.watchers) {
    try {
      w.close();
    } catch {
      // Ignore errors when closing watchers
    }
  }
  pw.watchers = [];
  projectWatchers.delete(projectId);
  log.info(`Git watcher: stopped for project ${projectId}`, { namespace: 'git-watcher' });
}

/** Close all watchers — called during shutdown */
function closeAllWatchers(): void {
  for (const [projectId, pw] of projectWatchers) {
    closeWatcher(projectId, pw);
  }
}

/**
 * Re-register existing active threads with the git watcher on server startup.
 * After a restart, the in-memory projectWatchers map is empty so external git
 * changes would go unnoticed for all pre-existing threads.
 *
 * Only threads with an active status (running/waiting/pending) are registered —
 * completed/idle threads don't need real-time git status updates. This avoids
 * a thundering-herd problem when projects accumulate hundreds of threads.
 * Threads are re-registered when an agent starts via the agent:started handler.
 */
const ACTIVE_STATUSES = new Set(['running', 'waiting', 'pending']);

export async function rehydrateWatchers(): Promise<void> {
  const projects = await getServices().projects.listProjects('');
  const { remoteListProjectThreads } = await import('./remote-project-identity-client.js');

  // Fetch threads for all projects in parallel
  const projectThreads = await Promise.all(
    projects.map(async (project) => {
      const threads = await remoteListProjectThreads(project.id);
      return { project, threads };
    }),
  );

  let total = 0;
  for (const { project, threads } of projectThreads) {
    for (const thread of threads) {
      // Only watch threads that have an active agent run
      if (!ACTIVE_STATUSES.has(thread.status ?? '')) continue;
      startWatching(
        project.id,
        project.path,
        thread.id,
        thread.userId,
        thread.worktreePath ?? null,
      );
      total++;
    }
  }

  if (total > 0) {
    log.info(`Git watcher: rehydrated ${total} thread(s) across ${projects.length} project(s)`, {
      namespace: 'git-watcher',
    });
  }
}

// Register shutdown cleanup
shutdownManager.register('git-watcher-service', () => closeAllWatchers(), ShutdownPhase.SERVICES);
