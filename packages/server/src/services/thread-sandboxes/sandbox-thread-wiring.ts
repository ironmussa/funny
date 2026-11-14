/**
 * Production wiring of the sandbox thread launcher (change thread-sandboxes):
 * the DB, the provider connections, runner-access calls and browser events.
 */

import { productionSandboxProviders } from '@funny/sandbox';
import { parseStoredJson } from '@funny/shared/json-validation';
import { and, asc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { repos } from '../../db/repos.js';
import { messages, projects } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import type { RunnerPresencePort, RunnerRequestPort } from '../runner-ports.js';
import { createInfraConnectionService } from './infra-connections.js';
import { createProjectSandboxSettingsService } from './project-sandbox-settings.js';
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
  const messageRepo = repos.messages();

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
      // A storage failure is a 500, never "no sandbox configured".
      if (configured.isErr()) throw new Error(configured.error.message);
      return configured.value;
    },
    prepare: (req) => prepareSandboxLaunch(req, { connections, ...ports }),
    insertThread: (row) => threadRepo.createThread(row),
    loadThread: (threadId) => threadRepo.getThread(threadId),
    findOwnedThread: async (userId, threadId) => {
      const thread = await threadRepo.getThread(threadId);
      return thread && thread.userId === userId ? thread : null;
    },
    previousSandbox: async (threadId) => {
      const row = await sqlThreadSandboxStore.get(threadId);
      // A storage failure is a 500, never "no previous sandbox".
      if (row.isErr()) throw new Error(row.error);
      return row.value;
    },
    saveFirstMessage: async ({ userId, threadId, content, timestamp, images, ...settings }) => {
      try {
        const existing = await messageRepo.getThreadMessages({ threadId, limit: 1 });
        if (existing.messages.length > 0) return null;
        const messageId = await messageRepo.insertMessage({
          threadId,
          role: 'user',
          content,
          timestamp,
          images: images?.length ? JSON.stringify(images) : null,
          model: settings.model ?? null,
          permissionMode: settings.permissionMode ?? null,
          effort: settings.effort ?? null,
        });
        env.browserEvents?.toUser(userId, {
          type: 'agent:message',
          threadId,
          data: { messageId, role: 'user', content, timestamp },
        });
        return messageId;
      } catch (error) {
        // Not fatal: without it the runner saves the message when the agent starts.
        log.error('Failed to save the first message of a sandbox thread', {
          namespace: 'thread-sandboxes',
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
    firstMessageImages: async (threadId) => {
      const [first] = await db
        .select({ images: messages.images })
        .from(messages)
        .where(and(eq(messages.threadId, threadId), eq(messages.role, 'user')))
        .orderBy(asc(messages.timestamp))
        .limit(1);
      if (!first?.images) return null;
      // The runner validates each image; here it only has to be a list.
      const parsed = parseStoredJson(z.array(z.unknown()), first.images, 'first message images');
      return parsed.ok ? parsed.value : null;
    },
    markSettingUp: async (threadId) => {
      const thread = await threadRepo.getThread(threadId);
      if (!thread) return;
      await threadRepo.updateThread(threadId, { status: 'setting_up' });
      env.browserEvents?.toUser(thread.userId, {
        type: 'thread:updated',
        threadId,
        data: { status: 'setting_up' },
      });
    },
    markReady: async (threadId) => {
      const thread = await threadRepo.getThread(threadId);
      if (!thread) return;
      await threadRepo.updateThread(threadId, { status: 'pending' });
      // The checkout may have recorded a different branch (the requested one
      // was not on the remote): send it with the status.
      env.browserEvents?.toUser(thread.userId, {
        type: 'thread:updated',
        threadId,
        data: {
          status: 'pending',
          ...(thread.baseBranch ? { baseBranch: thread.baseBranch } : {}),
        },
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
