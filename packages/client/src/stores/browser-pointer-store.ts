import type { BrowserSessionPointerKind } from '@funny/shared';
import { create } from 'zustand';

/** The agent's last pointer position in a session, in page viewport pixels. */
interface AgentPointer {
  x: number;
  y: number;
  kind: BrowserSessionPointerKind;
  /** Bumps on every event, so a second click on the same spot pulses again. */
  seq: number;
}

interface BrowserPointerState {
  bySession: Record<string, AgentPointer>;
  setPointer: (
    sessionId: string,
    pointer: { x: number; y: number; kind: BrowserSessionPointerKind },
  ) => void;
}

/**
 * Where the agent's mouse is, per browser session (`browser-session:pointer`).
 * The screencast has no cursor, so the panel draws one from this.
 */
export const useBrowserPointerStore = create<BrowserPointerState>((set) => ({
  bySession: {},
  setPointer: (sessionId, pointer) =>
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: { ...pointer, seq: (s.bySession[sessionId]?.seq ?? 0) + 1 },
      },
    })),
}));
