import { create } from 'zustand';

import { omitThread } from './by-thread';

export interface ActiveTool {
  name: string;
  input: Record<string, unknown>;
}

interface ThreadActiveToolState {
  /** Latest tool call of each running thread, keyed by thread id. */
  byThread: Record<string, ActiveTool>;
  setActive: (threadId: string, tool: ActiveTool) => void;
  clear: (threadId: string) => void;
}

/**
 * The tool each running thread is executing, learned from `agent:tool_call`
 * events, so the sidebar can say what an agent that has not written any text
 * yet is doing. Cleared when the agent writes text or the run stops. In memory
 * only: after a reload a thread shows its tool again on its next tool call.
 */
export const useThreadActiveToolStore = create<ThreadActiveToolState>((set) => ({
  byThread: {},
  setActive: (threadId, tool) => set((s) => ({ byThread: { ...s.byThread, [threadId]: tool } })),
  clear: (threadId) =>
    set((s) => {
      const byThread = omitThread(s.byThread, threadId);
      return byThread === s.byThread ? s : { byThread };
    }),
}));

export function useThreadActiveTool(threadId: string): ActiveTool | undefined {
  return useThreadActiveToolStore((s) => s.byThread[threadId]);
}

/** Tool call input arrives as an object or as its JSON string. */
export function parseToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}
