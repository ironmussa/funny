import type { WSEvent } from '@funny/shared';

import type { AgentStateTracker } from '../agent-state.js';
import type { IThreadManager } from '../server-interfaces.js';

/**
 * What the modules split out of AgentMessageHandler use of it: its state,
 * thread manager, project lookup, WebSocket emission and log context.
 */
export interface HandlerContext {
  state: AgentStateTracker;
  threadManager: IThreadManager;
  getProject(id: string): Promise<{ path: string; [key: string]: any } | undefined>;
  emitWS(threadId: string, type: WSEvent['type'], data: unknown): Promise<void>;
  threadCtx(threadId: string): Promise<Record<string, string>>;
}
