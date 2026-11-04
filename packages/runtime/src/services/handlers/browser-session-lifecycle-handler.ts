/**
 * @domain subdomain: Browser Automation
 * @domain subdomain-type: supporting
 * @domain type: handler
 * @domain layer: application
 * @domain consumes: thread:deleted, thread:stage-changed
 *
 * Closes a thread's browser session when the thread is deleted or archived,
 * so its Chromium tab does not linger until the idle timeout. Deleting also
 * revokes the thread's token for funny's MCP servers (`agent-mcp-http.ts`).
 */

import { revokeAgentMcpHttp } from '../agent-mcp-http.js';
import { browserSessionManager } from '../browser-session-manager.js';
import type { ThreadDeletedEvent, ThreadStageChangedEvent } from '../thread-event-bus.js';
import type { EventHandler } from './types.js';

export const browserSessionThreadDeletedHandler: EventHandler<'thread:deleted'> = {
  name: 'browser-session-close-on-thread-deleted',
  event: 'thread:deleted',

  action(event: ThreadDeletedEvent) {
    revokeAgentMcpHttp(event.threadId);
    return browserSessionManager.closeForThread(event.userId, event.threadId);
  },
};

export const browserSessionThreadArchivedHandler: EventHandler<'thread:stage-changed'> = {
  name: 'browser-session-close-on-thread-archived',
  event: 'thread:stage-changed',
  filter: (event: ThreadStageChangedEvent) => event.toStage === 'archived',

  action(event: ThreadStageChangedEvent) {
    return browserSessionManager.closeForThread(event.userId, event.threadId);
  },
};
