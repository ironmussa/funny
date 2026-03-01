import { setup } from 'xstate';

import type { ThreadStatus } from './types.js';

/**
 * Thread lifecycle state machine (shared between client and server)
 *
 * States:
 * - setting_up: Worktree is being created in the background
 * - pending: Thread created but not started
 * - running: Agent is actively working
 * - completed: Agent finished successfully
 * - failed: Agent encountered an error
 * - stopped: Agent was manually stopped by user
 * - interrupted: Agent was interrupted (e.g., server restart)
 * - waiting: Agent is waiting for user input (question/plan/permission)
 *
 * Valid transitions:
 * - setting_up → pending (SETUP_COMPLETE — worktree created, agent about to start)
 * - setting_up → idle (SETUP_COMPLETE — idle thread, no agent)
 * - setting_up → failed (FAIL — worktree creation failed)
 * - pending → running (START)
 * - running → completed (COMPLETE)
 * - running → failed (FAIL)
 * - running → stopped (STOP)
 * - running → interrupted (INTERRUPT)
 * - running → waiting (WAIT)
 * - waiting → running (RESPOND — user answered a question/plan)
 * - stopped → running (RESTART — genuine resume after interruption)
 * - failed → running (RESTART)
 * - completed → running (FOLLOW_UP — new message after completion)
 * - interrupted → running (RESTART)
 *
 * The `resumeReason` context field tells downstream code WHY we entered
 * the `running` state, so it can choose the right system prefix for the
 * Claude session resume.
 */

// ── Types ─────────────────────────────────────────────────────────

export type ResumeReason =
  | 'fresh' // First start, no session to resume
  | 'waiting-response' // User responded to question/plan/permission
  | 'interrupted' // Genuine resume after stop/fail/interrupt
  | 'follow-up' // New message sent after agent completed
  | 'post-merge' // Follow-up after worktree merge
  | null; // Unknown / not set

export interface ThreadContext {
  threadId: string;
  cost: number;
  resumeReason: ResumeReason;
  resultInfo?: {
    status: 'completed' | 'failed';
    cost: number;
    duration: number;
    error?: string;
  };
}

export type ThreadEvent =
  | { type: 'START' }
  | { type: 'SETUP_COMPLETE' }
  | { type: 'RESPOND' }
  | { type: 'RESTART' }
  | { type: 'FOLLOW_UP' }
  | { type: 'COMPLETE'; cost?: number; duration?: number }
  | { type: 'FAIL'; cost?: number; duration?: number; error?: string }
  | { type: 'WAIT'; cost?: number; duration?: number }
  | { type: 'STOP' }
  | { type: 'INTERRUPT' }
  | { type: 'SET_STATUS'; status: ThreadStatus };

// ── Machine ───────────────────────────────────────────────────────

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
          error: event.type === 'FAIL' ? event.error : undefined,
        };
      }
    },
    clearResultInfo: ({ context }) => {
      context.resultInfo = undefined;
    },
    setResumeFresh: ({ context }) => {
      context.resumeReason = 'fresh';
    },
    setResumeWaitingResponse: ({ context }) => {
      context.resumeReason = 'waiting-response';
    },
    setResumeInterrupted: ({ context }) => {
      context.resumeReason = 'interrupted';
    },
    setResumeFollowUp: ({ context }) => {
      context.resumeReason = 'follow-up';
    },
    clearResumeReason: ({ context }) => {
      context.resumeReason = null;
    },
  },
}).createMachine({
  id: 'thread',
  initial: 'pending',
  context: ({ input }) => ({
    threadId: (input as ThreadContext).threadId,
    cost: (input as ThreadContext).cost ?? 0,
    resumeReason: (input as ThreadContext).resumeReason ?? null,
    resultInfo: (input as ThreadContext).resultInfo,
  }),
  states: {
    setting_up: {
      on: {
        SETUP_COMPLETE: { target: 'pending', actions: 'clearResultInfo' },
        FAIL: {
          target: 'failed',
          actions: ['setResultInfo', 'clearResumeReason'],
        },
        SET_STATUS: [
          { target: 'pending', guard: ({ event }) => event.status === 'pending' },
          { target: 'idle', guard: ({ event }) => event.status === 'idle' },
          { target: 'failed', guard: ({ event }) => event.status === 'failed' },
          {
            target: 'running',
            guard: ({ event }) => event.status === 'running',
            actions: 'setResumeFresh',
          },
        ],
      },
    },
    idle: {
      on: {
        START: { target: 'running', actions: ['clearResultInfo', 'setResumeFresh'] },
        SET_STATUS: [
          {
            target: 'running',
            guard: ({ event }) => event.status === 'running',
            actions: 'setResumeFresh',
          },
          { target: 'pending', guard: ({ event }) => event.status === 'pending' },
          { target: 'failed', guard: ({ event }) => event.status === 'failed' },
        ],
      },
    },
    pending: {
      on: {
        START: { target: 'running', actions: ['clearResultInfo', 'setResumeFresh'] },
        SET_STATUS: [
          { target: 'setting_up', guard: ({ event }) => event.status === 'setting_up' },
          { target: 'idle', guard: ({ event }) => event.status === 'idle' },
          {
            target: 'running',
            guard: ({ event }) => event.status === 'running',
            actions: 'setResumeFresh',
          },
          { target: 'waiting', guard: ({ event }) => event.status === 'waiting' },
          { target: 'completed', guard: ({ event }) => event.status === 'completed' },
          { target: 'failed', guard: ({ event }) => event.status === 'failed' },
          { target: 'stopped', guard: ({ event }) => event.status === 'stopped' },
          { target: 'interrupted', guard: ({ event }) => event.status === 'interrupted' },
        ],
      },
    },
    running: {
      on: {
        START: { target: 'running', actions: 'clearResultInfo' }, // self-transition
        COMPLETE: {
          target: 'completed',
          actions: ['updateCost', 'setResultInfo', 'clearResumeReason'],
        },
        FAIL: {
          target: 'failed',
          actions: ['updateCost', 'setResultInfo', 'clearResumeReason'],
        },
        WAIT: {
          target: 'waiting',
          actions: ['updateCost', 'clearResumeReason'],
        },
        STOP: { target: 'stopped', actions: 'clearResumeReason' },
        INTERRUPT: { target: 'interrupted', actions: 'clearResumeReason' },
        SET_STATUS: [
          {
            target: 'completed',
            guard: ({ event }) => event.status === 'completed',
            actions: 'clearResumeReason',
          },
          {
            target: 'failed',
            guard: ({ event }) => event.status === 'failed',
            actions: 'clearResumeReason',
          },
          {
            target: 'stopped',
            guard: ({ event }) => event.status === 'stopped',
            actions: 'clearResumeReason',
          },
          {
            target: 'interrupted',
            guard: ({ event }) => event.status === 'interrupted',
            actions: 'clearResumeReason',
          },
          {
            target: 'waiting',
            guard: ({ event }) => event.status === 'waiting',
            actions: 'clearResumeReason',
          },
        ],
      },
    },
    waiting: {
      on: {
        RESPOND: { target: 'running', actions: ['clearResultInfo', 'setResumeWaitingResponse'] },
        START: { target: 'running', actions: ['clearResultInfo', 'setResumeWaitingResponse'] },
        RESTART: { target: 'running', actions: ['clearResultInfo', 'setResumeWaitingResponse'] },
        COMPLETE: {
          target: 'completed',
          actions: ['updateCost', 'setResultInfo', 'clearResumeReason'],
        },
        FAIL: {
          target: 'failed',
          actions: ['updateCost', 'setResultInfo', 'clearResumeReason'],
        },
        WAIT: {
          // Self-transition: stay in waiting (e.g., result confirms waiting status)
          target: 'waiting',
          actions: ['updateCost'],
        },
        STOP: { target: 'stopped', actions: 'clearResumeReason' },
        SET_STATUS: [
          {
            target: 'running',
            guard: ({ event }) => event.status === 'running',
            actions: 'setResumeWaitingResponse',
          },
          {
            target: 'completed',
            guard: ({ event }) => event.status === 'completed',
            actions: 'clearResumeReason',
          },
          {
            target: 'failed',
            guard: ({ event }) => event.status === 'failed',
            actions: 'clearResumeReason',
          },
          {
            target: 'stopped',
            guard: ({ event }) => event.status === 'stopped',
            actions: 'clearResumeReason',
          },
        ],
      },
    },
    completed: {
      on: {
        FOLLOW_UP: { target: 'running', actions: ['clearResultInfo', 'setResumeFollowUp'] },
        RESTART: { target: 'running', actions: ['clearResultInfo', 'setResumeFollowUp'] },
        START: { target: 'running', actions: ['clearResultInfo', 'setResumeFollowUp'] },
        STOP: { target: 'stopped', actions: 'clearResultInfo' },
        INTERRUPT: { target: 'interrupted', actions: 'clearResultInfo' },
        SET_STATUS: [
          {
            target: 'running',
            guard: ({ event }) => event.status === 'running',
            actions: ['clearResultInfo', 'setResumeFollowUp'],
          },
          { target: 'stopped', guard: ({ event }) => event.status === 'stopped' },
          { target: 'interrupted', guard: ({ event }) => event.status === 'interrupted' },
        ],
      },
    },
    failed: {
      on: {
        RESTART: { target: 'running', actions: ['clearResultInfo', 'setResumeInterrupted'] },
        START: { target: 'running', actions: ['clearResultInfo', 'setResumeInterrupted'] },
        SET_STATUS: [
          {
            target: 'running',
            guard: ({ event }) => event.status === 'running',
            actions: ['clearResultInfo', 'setResumeInterrupted'],
          },
        ],
      },
    },
    stopped: {
      on: {
        RESTART: { target: 'running', actions: ['clearResultInfo', 'setResumeInterrupted'] },
        START: { target: 'running', actions: ['clearResultInfo', 'setResumeInterrupted'] },
        SET_STATUS: [
          {
            target: 'running',
            guard: ({ event }) => event.status === 'running',
            actions: ['clearResultInfo', 'setResumeInterrupted'],
          },
        ],
      },
    },
    interrupted: {
      on: {
        RESTART: { target: 'running', actions: ['clearResultInfo', 'setResumeInterrupted'] },
        START: { target: 'running', actions: ['clearResultInfo', 'setResumeInterrupted'] },
        SET_STATUS: [
          {
            target: 'running',
            guard: ({ event }) => event.status === 'running',
            actions: ['clearResultInfo', 'setResumeInterrupted'],
          },
        ],
      },
    },
  },
});

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Map WebSocket event types to machine events.
 * Used by the client to translate incoming WS messages.
 */
export function wsEventToMachineEvent(wsEventType: string, data: any): ThreadEvent | null {
  switch (wsEventType) {
    case 'agent:status':
      if (data.status === 'running') return { type: 'START' };
      if (data.status === 'stopped') return { type: 'STOP' };
      if (data.status === 'interrupted') return { type: 'INTERRUPT' };
      return { type: 'SET_STATUS', status: data.status };

    case 'agent:result': {
      const status = data.status ?? 'completed';
      if (status === 'waiting') {
        return { type: 'WAIT', cost: data.cost, duration: data.duration };
      } else if (status === 'completed') {
        return { type: 'COMPLETE', cost: data.cost, duration: data.duration };
      } else if (status === 'failed') {
        return { type: 'FAIL', cost: data.cost, duration: data.duration, error: data.error };
      }
      return null;
    }

    case 'agent:error':
      return { type: 'FAIL', error: data.error };

    case 'worktree:setup_complete':
      return { type: 'SETUP_COMPLETE' };

    default:
      return null;
  }
}

/**
 * Map a ResumeReason to the appropriate system prefix for Claude session resume.
 * Returns undefined when no prefix is needed (fresh start).
 */
export function getResumeSystemPrefix(
  reason: ResumeReason,
  isPostMerge?: boolean,
): string | undefined {
  if (isPostMerge) {
    return '[SYSTEM NOTE: This is a follow-up after your previous work was merged into the main branch. The worktree and feature branch have been cleaned up. You are now working in the main project directory. Your conversation history is preserved — continue naturally.]';
  }

  switch (reason) {
    case 'fresh':
      return undefined;
    case 'waiting-response':
      return '[SYSTEM NOTE: The user has responded to your question or plan approval request. Continue naturally based on their response.]';
    case 'follow-up':
      return '[SYSTEM NOTE: The user has sent a follow-up message after your previous work completed. Continue naturally based on their new request.]';
    case 'interrupted':
      return '[SYSTEM NOTE: This is a session resume after an interruption. Your previous session was interrupted mid-execution. Continue from where you left off. Do NOT re-plan or start over — pick up execution from the last completed step.]';
    default:
      return undefined;
  }
}
