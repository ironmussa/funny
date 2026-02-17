import { setup, fromPromise } from 'xstate';
import type { ThreadStatus } from '@funny/shared';

/**
 * Thread lifecycle state machine
 *
 * States:
 * - pending: Thread created but not started
 * - running: Agent is actively working
 * - completed: Agent finished successfully
 * - failed: Agent encountered an error
 * - stopped: Agent was manually stopped by user
 * - interrupted: Agent was interrupted (e.g., server restart)
 *
 * Valid transitions:
 * - pending → running (on start)
 * - running → completed (on success)
 * - running → failed (on error)
 * - running → stopped (on manual stop)
 * - running → interrupted (on server crash)
 * - running → waiting (on AskUserQuestion/ExitPlanMode)
 * - waiting → running (on user response)
 * - stopped → running (on restart)
 * - failed → running (on retry)
 * - completed → running (on restart - new follow-up message)
 */

export interface ThreadContext {
  threadId: string;
  cost: number;
  resultInfo?: {
    status: 'completed' | 'failed';
    cost: number;
    duration: number;
  };
}

export type ThreadEvent =
  | { type: 'START' }
  | { type: 'COMPLETE'; cost?: number; duration?: number }
  | { type: 'FAIL'; cost?: number; duration?: number }
  | { type: 'WAIT'; cost?: number; duration?: number }
  | { type: 'STOP' }
  | { type: 'INTERRUPT' }
  | { type: 'RESTART' }
  | { type: 'SET_STATUS'; status: ThreadStatus };

export const threadMachine = setup({
  types: {
    context: {} as ThreadContext,
    events: {} as ThreadEvent,
  },
  actions: {
    updateCost: ({ context, event }) => {
      if ('cost' in event && event.cost !== undefined) {
        context.cost = event.cost;
      }
    },
    setResultInfo: ({ context, event }) => {
      if (event.type === 'COMPLETE' || event.type === 'FAIL') {
        context.resultInfo = {
          status: event.type === 'COMPLETE' ? 'completed' : 'failed',
          cost: event.cost ?? context.cost,
          duration: event.duration ?? 0,
        };
      }
    },
    clearResultInfo: ({ context }) => {
      context.resultInfo = undefined;
    },
  },
}).createMachine({
  id: 'thread',
  initial: 'pending',
  context: ({ input }) => ({
    threadId: (input as ThreadContext).threadId,
    cost: (input as ThreadContext).cost,
    resultInfo: (input as ThreadContext).resultInfo,
  }),
  states: {
    pending: {
      on: {
        START: 'running',
        SET_STATUS: [
          { target: 'running', guard: ({ event }) => event.status === 'running' },
          { target: 'waiting', guard: ({ event }) => event.status === 'waiting' },
          { target: 'completed', guard: ({ event }) => event.status === 'completed' },
          { target: 'failed', guard: ({ event }) => event.status === 'failed' },
          { target: 'stopped', guard: ({ event }) => event.status === 'stopped' },
          { target: 'interrupted', guard: ({ event }) => event.status === 'interrupted' },
        ],
      },
    },
    running: {
      entry: 'clearResultInfo',
      on: {
        START: 'running', // self-transition: server confirms running while already running
        COMPLETE: {
          target: 'completed',
          actions: ['updateCost', 'setResultInfo'],
        },
        FAIL: {
          target: 'failed',
          actions: ['updateCost', 'setResultInfo'],
        },
        WAIT: {
          target: 'waiting',
          actions: ['updateCost'],
        },
        STOP: 'stopped',
        INTERRUPT: 'interrupted',
        SET_STATUS: [
          { target: 'completed', guard: ({ event }) => event.status === 'completed' },
          { target: 'failed', guard: ({ event }) => event.status === 'failed' },
          { target: 'stopped', guard: ({ event }) => event.status === 'stopped' },
          { target: 'interrupted', guard: ({ event }) => event.status === 'interrupted' },
          { target: 'waiting', guard: ({ event }) => event.status === 'waiting' },
        ],
      },
    },
    waiting: {
      on: {
        START: 'running',
        RESTART: 'running',
        COMPLETE: {
          target: 'completed',
          actions: ['updateCost', 'setResultInfo'],
        },
        FAIL: {
          target: 'failed',
          actions: ['updateCost', 'setResultInfo'],
        },
        WAIT: {
          // Self-transition: stay in waiting (e.g., result confirms waiting status)
          target: 'waiting',
          actions: ['updateCost'],
        },
        STOP: 'stopped',
        SET_STATUS: [
          { target: 'running', guard: ({ event }) => event.status === 'running' },
          { target: 'completed', guard: ({ event }) => event.status === 'completed' },
          { target: 'failed', guard: ({ event }) => event.status === 'failed' },
          { target: 'stopped', guard: ({ event }) => event.status === 'stopped' },
        ],
      },
    },
    completed: {
      on: {
        RESTART: 'running',
        START: 'running',
        STOP: { target: 'stopped', actions: 'clearResultInfo' },
        INTERRUPT: { target: 'interrupted', actions: 'clearResultInfo' },
        SET_STATUS: [
          { target: 'running', guard: ({ event }) => event.status === 'running' },
          { target: 'stopped', guard: ({ event }) => event.status === 'stopped' },
          { target: 'interrupted', guard: ({ event }) => event.status === 'interrupted' },
        ],
      },
    },
    failed: {
      on: {
        RESTART: 'running',
        START: 'running',
        SET_STATUS: [
          { target: 'running', guard: ({ event }) => event.status === 'running' },
        ],
      },
    },
    stopped: {
      on: {
        RESTART: 'running',
        START: 'running',
        SET_STATUS: [
          { target: 'running', guard: ({ event }) => event.status === 'running' },
        ],
      },
    },
    interrupted: {
      on: {
        RESTART: 'running',
        START: 'running',
        SET_STATUS: [
          { target: 'running', guard: ({ event }) => event.status === 'running' },
        ],
      },
    },
  },
});

/**
 * Helper to map WebSocket event types to machine events
 */
export function wsEventToMachineEvent(
  wsEventType: string,
  data: any
): ThreadEvent | null {
  switch (wsEventType) {
    case 'agent:status':
      if (data.status === 'running') return { type: 'START' };
      if (data.status === 'stopped') return { type: 'STOP' };
      if (data.status === 'interrupted') return { type: 'INTERRUPT' };
      return { type: 'SET_STATUS', status: data.status };

    case 'agent:result':
      const status = data.status ?? 'completed';
      if (status === 'waiting') {
        return { type: 'WAIT', cost: data.cost, duration: data.duration };
      } else if (status === 'completed') {
        return { type: 'COMPLETE', cost: data.cost, duration: data.duration };
      } else if (status === 'failed') {
        return { type: 'FAIL', cost: data.cost, duration: data.duration };
      }
      return null;

    case 'agent:error':
      return { type: 'FAIL' };

    default:
      return null;
  }
}
