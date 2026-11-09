/**
 * Production wiring of the sandbox thread launcher (change thread-sandboxes):
 * the DB, the provider connections, runner-access calls and browser events.
 */

import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db } from '../../db/index.js';
import { repos } from '../../db/repos.js';
import { projects } from '../../db/schema.js';
import type { RunnerPresencePort, RunnerRequestPort } from '../runner-ports.js';
import { createInfraConnectionService } from './infra-connections.js';
import { createProjectSandboxSettingsService } from './project-sandbox-settings.js';
import { productionSandboxProviders } from './provider-catalog.js';
import { postSandboxError } from './sandbox-events.js';
import { prepareSandboxLaunch } from './sandbox-launch.js';
import { createSandboxRunnerCalls } from './sandbox-runner-calls.js';
import { createSandboxThreadLauncher } from './sandbox-thread.js';
import { sqlThreadSandboxStore } from './thread-sandbox-store.js';

interface BrowserEventsPort {
  toUser(userId: string, event: Record<string, unknown>): void;
}

export function sandboxThreadLauncherFor(env: {
  runnerRequests?: RunnerRequestPort;
  runnerPresence?: RunnerPresencePort;
  browserEvents?: BrowserEventsPort;
}) {
  const registry = productionSandboxProviders();
  if (registry.isErr()) throw new Error(`sandbox provider registry: ${registry.error.kind}`);
  const connections = createInfraConnectionService(registry.value);
  const projectSandboxes = createProjectSandboxSettingsService(connections);
  const ports = { requests: env.runnerRequests, presence: env.runnerPresence };
  const calls = createSandboxRunnerCalls(ports);
  const threadRepo = repos.threads();

  return createSandboxThreadLauncher({
    findOwnedProject: async (userId, projectId) => {
      const [row] = await db
        .select({ path: projects.path })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)));
      return row ?? null;
    },
    projectSandbox: async (userId, projectId) => {
      const configured = await projectSandboxes.forThread(userId, projectId);
      return configured.isOk() ? configured.value : null;
    },
    prepare: (req) => prepareSandboxLaunch(req, { connections, ...ports }),
    insertThread: (row) => threadRepo.createThread(row),
    loadThread: (threadId) => threadRepo.getThread(threadId),
    markReady: async (threadId) => {
      const thread = await threadRepo.getThread(threadId);
      if (!thread) return;
      await threadRepo.updateThread(threadId, { status: 'pending' });
      env.browserEvents?.toUser(thread.userId, {
        type: 'thread:updated',
        threadId,
        data: { status: 'pending' },
      });
    },
    markFailed: async (threadId, failure) => {
      const thread = await threadRepo.getThread(threadId);
      if (!thread) return;
      const reason = failure.hint ? `${failure.message}\n\n${failure.hint}` : failure.message;
      await threadRepo.updateThread(threadId, { status: 'failed' });
      // Keep the reason where the setup view reads it (the sandbox itself may
      // be up: the failure can be the first message, not the machine)…
      await sqlThreadSandboxStore.update(threadId, { error: reason });
      env.browserEvents?.toUser(thread.userId, {
        type: 'thread:updated',
        threadId,
        data: { status: 'failed', error: reason },
      });
      // …and as a card in the conversation's history.
      await postSandboxError({ threadId, userId: thread.userId, data: failure }, env.browserEvents);
    },
    sendMessage: calls.sendMessage,
    newId: () => nanoid(),
  });
}
