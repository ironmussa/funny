/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: infrastructure
 * @domain emits: git:changed
 *
 * Watches `.git/` internals (index, HEAD, refs/) for external changes.
 * Per-project lifecycle: starts watching when the first thread is created,
 * stops when the last thread is deleted. Emits `git:changed` on the
 * ThreadEventBus for all active (non-archived) threads in that project.
 */

import { watch, type FSWatcher } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';

import { log } from '../lib/logger.js';
import { getServices } from './service-registry.js';
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
import { threadEventBus } from './thread-event-bus.js';
import { listThreads } from './thread-manager.js';

const DEBOUNCE_MS = 300;

interface ProjectWatcher {
  /** Thread IDs that requested watching for this project */
  threadIds: Set<string>;
  /** Active FSWatcher instances */
  watchers: FSWatcher[];
  /** Debounce timer for batching rapid changes */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Project path (for resolving .git/) */
  projectPath: string;
}

const projectWatchers = new Map<string, ProjectWatcher>();

/**
 * Start watching a project's .git/ directory for external changes.
 * If the project is already being watched, just registers the thread.
 */
export function startWatching(projectId: string, projectPath: string, threadId: string): void {
  let pw = projectWatchers.get(projectId);

  if (pw) {
    pw.threadIds.add(threadId);
    log.debug(
      `Git watcher: added thread ${threadId} to project ${projectId} (${pw.threadIds.size} threads)`,
      {
        namespace: 'git-watcher',
      },
    );
    return;
  }

  // First thread for this project — create watchers
  pw = {
    threadIds: new Set([threadId]),
    watchers: [],
    debounceTimer: null,
    projectPath,
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

  pw.threadIds.delete(threadId);
  log.debug(
    `Git watcher: removed thread ${threadId} from project ${projectId} (${pw.threadIds.size} remaining)`,
    {
      namespace: 'git-watcher',
    },
  );

  if (pw.threadIds.size === 0) {
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
    void emitForAllThreads(projectId, pw);
  }, DEBOUNCE_MS);
}

/** Emit `git:changed` for every non-archived thread in this project */
async function emitForAllThreads(projectId: string, pw: ProjectWatcher): Promise<void> {
  const project = await getServices().projects.getProject(projectId);
  if (!project) return;

  // Query all active threads for this project once
  const threads = await listThreads({ projectId, userId: '', includeArchived: false });
  const threadMap = new Map(threads.map((t) => [t.id, t]));

  let emitted = 0;
  for (const threadId of pw.threadIds) {
    const thread = threadMap.get(threadId);
    if (!thread) continue;

    threadEventBus.emit('git:changed', {
      threadId,
      projectId,
      userId: thread.userId,
      worktreePath: thread.worktreePath,
      cwd: thread.worktreePath ?? project.path,
      toolName: 'external',
    });
    emitted++;
  }

  log.debug(`Git watcher: emitted git:changed for ${emitted} thread(s) in project ${projectId}`, {
    namespace: 'git-watcher',
  });
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
export function closeAllWatchers(): void {
  for (const [projectId, pw] of projectWatchers) {
    closeWatcher(projectId, pw);
  }
}

/**
 * Re-register existing active threads with the git watcher on server startup.
 * After a restart, the in-memory projectWatchers map is empty so external git
 * changes would go unnoticed for all pre-existing threads.
 */
export async function rehydrateWatchers(): Promise<void> {
  const projects = await getServices().projects.listProjects('');
  let total = 0;

  for (const project of projects) {
    const threads = await listThreads({
      projectId: project.id,
      userId: '',
      includeArchived: false,
    });

    for (const thread of threads) {
      startWatching(project.id, project.path, thread.id);
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
