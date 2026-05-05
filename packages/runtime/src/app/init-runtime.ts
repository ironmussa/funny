import { deriveGitSyncState, getNativeGit, getStatusSummary } from '@funny/core/git';
import type { Hono } from 'hono';

import { log } from '../lib/logger.js';
import { invalidateGitStatusCacheByProject } from '../routes/git.js';
import { startAgent } from '../services/agent-runner.js';
import { rehydrateWatchers } from '../services/git-watcher-service.js';
import { registerAllHandlers } from '../services/handlers/handler-registry.js';
import type { HandlerServiceContext } from '../services/handlers/types.js';
import * as ptyManager from '../services/pty-manager.js';
import { getServices, setServices } from '../services/service-registry.js';
import * as tm from '../services/thread-manager.js';
import { wsBroker } from '../services/ws-broker.js';
import { logProviderStatus } from '../utils/provider-detection.js';
import { handlePtyMessage } from './pty-message-handler.js';

/**
 * Runs every "after the Hono app is built" startup task: create the runner
 * service provider, register handler registry, log provider status,
 * reattach PTY sessions, eagerly load native git, connect to the central
 * server, rehydrate git watchers, and auto-resume crashed threads.
 *
 * Pulled out of app.ts so the bootstrap file doesn't import 11+ services
 * directly.
 */
export async function initRuntime(app: Hono): Promise<void> {
  const { createRunnerServiceProvider } = await import('../services/runner-service-provider.js');
  setServices(createRunnerServiceProvider());
  log.info('Runner service provider created', { namespace: 'server' });

  const handlerCtx: HandlerServiceContext = {
    getThread: tm.getThread,
    updateThread: tm.updateThread,
    insertComment: tm.insertComment,
    getProject: getServices().projects.getProject,
    emitToUser: (userId, event) => wsBroker.emitToUser(userId, event),
    broadcast: (event) => wsBroker.emit(event),
    startAgent: (
      threadId,
      prompt,
      cwd,
      model,
      permissionMode,
      images,
      disallowedTools,
      allowedTools,
      provider,
      skipMessageInsert,
    ) =>
      startAgent(
        threadId,
        prompt,
        cwd,
        model,
        permissionMode,
        images,
        disallowedTools,
        allowedTools,
        provider,
        undefined,
        skipMessageInsert,
      ),
    getGitStatusSummary: getStatusSummary,
    deriveGitSyncState,
    invalidateGitStatusCache: invalidateGitStatusCacheByProject,
    saveThreadEvent: getServices().threadEvents.saveThreadEvent,
    dequeueMessage: getServices().messageQueue.dequeue,
    enqueueMessage: getServices().messageQueue.enqueue,
    queueCount: getServices().messageQueue.queueCount,
    peekMessage: getServices().messageQueue.peek,
    log: (msg) => log.info(msg, { namespace: 'handler' }),
  };
  registerAllHandlers(handlerCtx);

  await logProviderStatus();
  await ptyManager.reattachSessions();
  getNativeGit();

  if (!process.env.RUNNER_AUTH_SECRET) {
    log.error('RUNNER_AUTH_SECRET is required when TEAM_SERVER_URL is set.', {
      namespace: 'server',
    });
    process.exit(1);
  }
  const { initTeamMode, setBrowserWSHandler, setLocalApp } =
    await import('../services/team-client.js');
  setLocalApp(app);
  setBrowserWSHandler(async (userId, data, respond) => {
    const parsed = data as { type: string; data: any };
    if (!parsed?.type) return;
    handlePtyMessage(parsed.type, parsed.data, userId, (msg) => respond(msg));
  });
  await initTeamMode(process.env.TEAM_SERVER_URL!);

  rehydrateWatchers().catch((err) => {
    log.error('Failed to rehydrate git watchers', {
      namespace: 'server',
      error: (err as Error).message,
    });
  });

  autoResumeStaleThreads().catch((err) => {
    log.error('Failed to auto-resume stale threads', {
      namespace: 'server',
      error: (err as Error).message,
    });
  });
}

/**
 * On startup, find threads that were running when the runtime crashed,
 * mark them as interrupted, and automatically resume each one.
 */
async function autoResumeStaleThreads(): Promise<void> {
  const { remoteMarkAndListStaleThreads } = await import('../services/team-client.js');
  const staleThreads = await remoteMarkAndListStaleThreads();
  if (staleThreads.length === 0) return;

  log.info(`Auto-resuming ${staleThreads.length} interrupted thread(s)`, {
    namespace: 'server',
    count: staleThreads.length,
    threadIds: staleThreads.map((t: any) => t.id),
  });

  for (const thread of staleThreads) {
    try {
      let cwd = thread.worktreePath;
      if (!cwd) {
        const pathResult = await getServices().projects.resolveProjectPath(
          thread.projectId,
          thread.userId,
        );
        if (pathResult.isErr()) {
          log.warn('Cannot auto-resume thread — failed to resolve project path', {
            namespace: 'server',
            threadId: thread.id,
            error: pathResult.error.message,
          });
          continue;
        }
        cwd = pathResult.value;
      }

      await startAgent(
        thread.id,
        'continue',
        cwd,
        thread.model,
        thread.permissionMode,
        undefined,
        undefined,
        undefined,
        thread.provider,
      );

      log.info('Auto-resumed thread', {
        namespace: 'server',
        threadId: thread.id,
        model: thread.model,
        provider: thread.provider,
      });
    } catch (err) {
      log.error('Failed to auto-resume thread', {
        namespace: 'server',
        threadId: thread.id,
        error: (err as Error).message,
      });
    }
  }
}
