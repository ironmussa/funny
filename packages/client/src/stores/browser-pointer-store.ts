import type { BrowserSessionAgentAction, BrowserSessionPointerKind } from '@funny/shared';
import { create } from 'zustand';

/** The agent's last pointer position in a session, in page viewport pixels. */
interface AgentPointer {
  x: number;
  y: number;
  kind: BrowserSessionPointerKind;
  /** Bumps on every event, so a second click on the same spot pulses again. */
  seq: number;
}

/** The agent's last action in a session, drawn once over the screencast. */
export interface AgentActionState extends BrowserSessionAgentAction {
  /** Bumps on every action, so the same action twice plays its effect twice. */
  seq: number;
}

interface BrowserPointerState {
  bySession: Record<string, AgentPointer>;
  actionBySession: Record<string, AgentActionState>;
  setPointer: (
    sessionId: string,
    pointer: { x: number; y: number; kind: BrowserSessionPointerKind },
  ) => void;
  setAction: (sessionId: string, action: BrowserSessionAgentAction) => void;
}

/**
 * Where the agent's mouse is and what it last did, per browser session
 * (`browser-session:pointer`, `browser-session:agent-action`). The screencast
 * has no cursor, so the panel draws one, with the action's effect, from this.
 */
export const useBrowserPointerStore = create<BrowserPointerState>((set) => ({
  bySession: {},
  actionBySession: {},
  setPointer: (sessionId, pointer) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: { ...pointer, seq: (s.bySession[sessionId]?.seq ?? 0) + 1 },
      },
    })),
  setAction: (sessionId, action) =>
    set((s) => ({
      actionBySession: {
        ...s.actionBySession,
        [sessionId]: { ...action, seq: (s.actionBySession[sessionId]?.seq ?? 0) + 1 },
      },
    })),
}));
