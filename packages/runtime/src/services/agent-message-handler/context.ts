/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: core
 * @domain type: port
 * @domain layer: application
 */

import type { WSEvent } from '@funny/shared';

import type { WSEventData } from '../agent-event-router.js';
import type { AgentStateTracker } from '../agent-state.js';
import type { IThreadManager } from '../server-interfaces.js';

/** A project as the message handler reads it: its directory, plus opaque extras. */
export type HandlerProject = { path: string; [key: string]: any };

/**
 * What the modules split out of `AgentMessageHandler` need from it: its
 * state, the thread manager, and its project lookup, WS emission and log
 * context.
 */
export interface MessageHandlerContext {
  readonly state: AgentStateTracker;
  readonly threadManager: IThreadManager;
  getProject(id: string): Promise<HandlerProject | undefined>;
  emitWS<T extends WSEvent['type']>(threadId: string, type: T, data: WSEventData<T>): Promise<void>;
  threadCtx(threadId: string): Promise<Record<string, string>>;
}
