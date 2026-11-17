/**
 * Pin the terminal-spawn machine. Locks down the spawn/restore lifecycle so
 * future refactors of the timer/retry policy surface here as test failures.
 *
 * Side effects (`emitSpawn` / `emitRestore`) are stubbed via `.provide()` and
 * asserted as call counts — no WebSocket touched. Time is controlled with
 * vitest fake timers since the machine uses xstate's named delays.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createActor } from 'xstate';

import {
  MAX_SPAWN_ATTEMPTS,
  RESTORE_TIMEOUT_MS,
  SPAWN_TIMEOUT_MS,
  renderPhaseFromState,
  terminalSpawnMachine,
} from '@/machines/terminal-spawn-machine';

function makeActor(opts: {
  restored?: boolean;
  wasAliveOnMount?: boolean;
  emitSpawn?: () => void;
  emitRestore?: () => void;
  emitReattach?: () => void;
}) {
  const emitSpawn = opts.emitSpawn ?? vi.fn();
  const emitRestore = opts.emitRestore ?? vi.fn();
  const emitReattach = opts.emitReattach ?? vi.fn();
  const machine = terminalSpawnMachine.provide({
    actions: { emitSpawn, emitRestore, emitReattach },
  });
  const actor = createActor(machine, {
    input: {
      restored: opts.restored ?? false,
      wasAliveOnMount: opts.wasAliveOnMount ?? false,
    },
  });
  actor.start();
  return { actor, emitSpawn, emitRestore, emitReattach };
}

describe('terminalSpawnMachine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('session lost (server/runner restarted while the shell lived on)', () => {
    function connectedActor() {
      const made = makeActor({ wasAliveOnMount: true });
      made.actor.send({ type: 'TERM_READY' });
      made.actor.send({ type: 'PANEL_VISIBLE', visible: true });
      made.actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      made.actor.send({ type: 'DATA_RECEIVED' });
      expect(made.actor.getSnapshot().value).toBe('connected');
      return made;
    }

    test('re-attaches and returns to connected on the snapshot', () => {
      const { actor, emitReattach } = connectedActor();
      actor.send({ type: 'SESSION_LOST' });
      expect(actor.getSnapshot().value).toBe('reattaching');
      expect(emitReattach).toHaveBeenCalledTimes(1);
      actor.send({ type: 'DATA_RECEIVED' });
      expect(actor.getSnapshot().value).toBe('connected');
      actor.stop();
    });

    test('a re-attach that gets no answer ends in error', () => {
      const { actor } = connectedActor();
      actor.send({ type: 'SESSION_LOST' });
      vi.advanceTimersByTime(SPAWN_TIMEOUT_MS);
      expect(actor.getSnapshot().value).toBe('error');
      expect(actor.getSnapshot().context.error).toBe('terminal re-attach timed out');
      actor.stop();
    });
  });

  describe('initial state', () => {
    test('starts in initializing', () => {
      const { actor } = makeActor({});
      expect(actor.getSnapshot().value).toBe('initializing');
      actor.stop();
    });

    test('TERM_READY on a fresh-created tab moves to awaitingPanelVisible (skips sessions)', () => {
      const { actor } = makeActor({ wasAliveOnMount: true });
      actor.send({ type: 'TERM_READY' });
      expect(actor.getSnapshot().value).toBe('awaitingPanelVisible');
      actor.stop();
    });

    test('TERM_READY on a fresh-load tab parks in awaitingSessionsCheck', () => {
      const { actor } = makeActor({ wasAliveOnMount: false });
      actor.send({ type: 'TERM_READY' });
      expect(actor.getSnapshot().value).toBe('awaitingSessionsCheck');
      actor.stop();
    });

    test('TERM_READY on a restored tab moves to awaitingSocketRestore', () => {
      const { actor } = makeActor({ restored: true });
      actor.send({ type: 'TERM_READY' });
      expect(actor.getSnapshot().value).toBe('awaitingSocketRestore');
      actor.stop();
    });
  });

  describe('fresh-spawn happy path', () => {
    test('SESSIONS_CHECKED → PANEL_VISIBLE → SOCKET_CONNECTED emits pty:spawn exactly once', () => {
      const { actor, emitSpawn } = makeActor({ wasAliveOnMount: false });
      actor.send({ type: 'TERM_READY' });
      expect(actor.getSnapshot().value).toBe('awaitingSessionsCheck');

      actor.send({ type: 'SESSIONS_CHECKED' });
      expect(actor.getSnapshot().value).toBe('awaitingPanelVisible');

      actor.send({ type: 'PANEL_VISIBLE', visible: true });
      expect(actor.getSnapshot().value).toBe('awaitingSocketSpawn');
      expect(emitSpawn).not.toHaveBeenCalled();

      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      expect(actor.getSnapshot().value).toBe('spawning');
      expect(emitSpawn).toHaveBeenCalledTimes(1);

      actor.send({ type: 'DATA_RECEIVED' });
      expect(actor.getSnapshot().value).toBe('connected');
      actor.stop();
    });

    test('socket already connected when entering awaitingSocketSpawn → spawning fires immediately', () => {
      const { actor, emitSpawn } = makeActor({ wasAliveOnMount: true });
      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      actor.send({ type: 'PANEL_VISIBLE', visible: true });
      actor.send({ type: 'TERM_READY' });
      expect(actor.getSnapshot().value).toBe('spawning');
      expect(emitSpawn).toHaveBeenCalledTimes(1);
      actor.stop();
    });
  });

  describe('spawn retry policy', () => {
    test('timeout retries up to MAX_SPAWN_ATTEMPTS-1 times then errors out', () => {
      const { actor, emitSpawn } = makeActor({ wasAliveOnMount: true });
      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      actor.send({ type: 'PANEL_VISIBLE', visible: true });
      actor.send({ type: 'TERM_READY' });
      expect(actor.getSnapshot().value).toBe('spawning');
      expect(emitSpawn).toHaveBeenCalledTimes(1);

      // Each timeout retries while attempts+1 < MAX (i.e. attempts < MAX-1).
      // MAX=3 → retries on attempts 0 → 1, 1 → 2; on attempts 2 it errors.
      for (let i = 1; i < MAX_SPAWN_ATTEMPTS; i++) {
        vi.advanceTimersByTime(SPAWN_TIMEOUT_MS);
        expect(actor.getSnapshot().value).toBe('spawning');
        expect(emitSpawn).toHaveBeenCalledTimes(i + 1);
        expect(actor.getSnapshot().context.attempts).toBe(i);
      }

      vi.advanceTimersByTime(SPAWN_TIMEOUT_MS);
      expect(actor.getSnapshot().value).toBe('error');
      expect(actor.getSnapshot().context.error).toBe('spawn timed out');
      actor.stop();
    });

    test('DATA_RECEIVED before timeout cancels the retry', () => {
      const { actor, emitSpawn } = makeActor({ wasAliveOnMount: true });
      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      actor.send({ type: 'PANEL_VISIBLE', visible: true });
      actor.send({ type: 'TERM_READY' });
      vi.advanceTimersByTime(SPAWN_TIMEOUT_MS - 1);
      actor.send({ type: 'DATA_RECEIVED' });
      expect(actor.getSnapshot().value).toBe('connected');
      vi.advanceTimersByTime(SPAWN_TIMEOUT_MS * 5);
      expect(actor.getSnapshot().value).toBe('connected');
      expect(emitSpawn).toHaveBeenCalledTimes(1);
      actor.stop();
    });

    test('TAB_ERROR during spawn jumps to error immediately', () => {
      const { actor } = makeActor({ wasAliveOnMount: true });
      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      actor.send({ type: 'PANEL_VISIBLE', visible: true });
      actor.send({ type: 'TERM_READY' });
      actor.send({ type: 'TAB_ERROR', error: 'boom' });
      expect(actor.getSnapshot().value).toBe('error');
      expect(actor.getSnapshot().context.error).toBe('boom');
      actor.stop();
    });
  });

  describe('restore path', () => {
    test('restored tab waits for socket then emits pty:restore once', () => {
      const { actor, emitRestore, emitSpawn } = makeActor({ restored: true });
      actor.send({ type: 'TERM_READY' });
      expect(actor.getSnapshot().value).toBe('awaitingSocketRestore');
      expect(emitRestore).not.toHaveBeenCalled();

      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      expect(actor.getSnapshot().value).toBe('restoring');
      expect(emitRestore).toHaveBeenCalledTimes(1);
      expect(emitSpawn).not.toHaveBeenCalled();
      actor.stop();
    });

    test('restore safety timeout transitions to connected even without data', () => {
      const { actor } = makeActor({ restored: true });
      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      actor.send({ type: 'TERM_READY' });
      expect(actor.getSnapshot().value).toBe('restoring');
      vi.advanceTimersByTime(RESTORE_TIMEOUT_MS);
      expect(actor.getSnapshot().value).toBe('connected');
      actor.stop();
    });

    test('DATA_RECEIVED during restore moves straight to connected', () => {
      const { actor } = makeActor({ restored: true });
      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      actor.send({ type: 'TERM_READY' });
      actor.send({ type: 'DATA_RECEIVED' });
      expect(actor.getSnapshot().value).toBe('connected');
      actor.stop();
    });

    // Regression: tab persisted from a previous session mounts with
    // restored=false, then pty:list arrives and atomically flips both
    // tab.restored=true AND sessionsChecked=true. SET_RESTORED must reach
    // the machine before SESSIONS_CHECKED, otherwise the awaitingSessionsCheck
    // `always` re-evaluates with restored=false and emits pty:spawn against
    // a live PTY → server creates a duplicate, original session keeps writing
    // into the void → black terminal until remount. See user report
    // "cargo algun proyecto y el terminal queda negro".
    test('SET_RESTORED arriving alongside SESSIONS_CHECKED takes restore path, not spawn', () => {
      const { actor, emitSpawn, emitRestore } = makeActor({});
      actor.send({ type: 'TERM_READY' });
      expect(actor.getSnapshot().value).toBe('awaitingSessionsCheck');

      // pty:list response: bridge fires SET_RESTORED first, then SESSIONS_CHECKED.
      actor.send({ type: 'SET_RESTORED' });
      actor.send({ type: 'SESSIONS_CHECKED' });
      expect(actor.getSnapshot().value).toBe('awaitingSocketRestore');

      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      expect(actor.getSnapshot().value).toBe('restoring');
      expect(emitRestore).toHaveBeenCalledTimes(1);
      expect(emitSpawn).not.toHaveBeenCalled();
      actor.stop();
    });
  });

  describe('post-connection transitions', () => {
    test('TAB_EXITED moves connected → exited', () => {
      const { actor } = makeActor({ wasAliveOnMount: true });
      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      actor.send({ type: 'PANEL_VISIBLE', visible: true });
      actor.send({ type: 'TERM_READY' });
      actor.send({ type: 'DATA_RECEIVED' });
      actor.send({ type: 'TAB_EXITED' });
      expect(actor.getSnapshot().value).toBe('exited');
      actor.stop();
    });

    test('RESTART from exited resets restored/attempts/error and re-decides', () => {
      const { actor, emitSpawn } = makeActor({ restored: true });
      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      actor.send({ type: 'TERM_READY' });
      actor.send({ type: 'DATA_RECEIVED' });
      actor.send({ type: 'TAB_EXITED' });
      expect(actor.getSnapshot().value).toBe('exited');

      // After restart, restored is cleared so we go through the spawn path.
      // sessionsChecked persists from the original startup (sticky), so the
      // tab may proceed without waiting for another sessions check.
      actor.send({ type: 'SESSIONS_CHECKED' });
      actor.send({ type: 'PANEL_VISIBLE', visible: true });
      actor.send({ type: 'RESTART' });
      expect(actor.getSnapshot().value).toBe('spawning');
      expect(actor.getSnapshot().context.attempts).toBe(0);
      expect(actor.getSnapshot().context.restored).toBe(false);
      expect(actor.getSnapshot().context.error).toBeNull();
      expect(emitSpawn).toHaveBeenCalledTimes(1);
      actor.stop();
    });

    test('RESTART from error path follows the same reset', () => {
      const { actor } = makeActor({ wasAliveOnMount: true });
      actor.send({ type: 'SOCKET_CONNECTED', connected: true });
      actor.send({ type: 'PANEL_VISIBLE', visible: true });
      actor.send({ type: 'TERM_READY' });
      actor.send({ type: 'TAB_ERROR', error: 'fatal' });
      expect(actor.getSnapshot().value).toBe('error');

      actor.send({ type: 'RESTART' });
      // wasAliveOnMount sticky → goes back into spawning.
      expect(actor.getSnapshot().value).toBe('spawning');
      expect(actor.getSnapshot().context.error).toBeNull();
      actor.stop();
    });
  });

  describe('TAB_ERROR handled globally', () => {
    test('error during initializing is captured', () => {
      const { actor } = makeActor({});
      actor.send({ type: 'TAB_ERROR', error: 'pre-init crash' });
      expect(actor.getSnapshot().value).toBe('error');
      expect(actor.getSnapshot().context.error).toBe('pre-init crash');
      actor.stop();
    });
  });
});

describe('renderPhaseFromState', () => {
  test('error state always wins, regardless of runner status', () => {
    expect(renderPhaseFromState('error', 'offline')).toBe('error');
    expect(renderPhaseFromState('error', 'online')).toBe('error');
  });

  test('connected stays connected even if runner reports offline transiently', () => {
    expect(renderPhaseFromState('connected', 'offline')).toBe('connected');
    expect(renderPhaseFromState('connected', 'online')).toBe('connected');
  });

  test('exited stays exited regardless of runner status', () => {
    expect(renderPhaseFromState('exited', 'offline')).toBe('exited');
  });

  test('offline runner overrides any pre-connected state', () => {
    expect(renderPhaseFromState('initializing', 'offline')).toBe('awaiting-runner');
    expect(renderPhaseFromState('awaitingSessionsCheck', 'offline')).toBe('awaiting-runner');
    expect(renderPhaseFromState('spawning', 'offline')).toBe('awaiting-runner');
    expect(renderPhaseFromState('restoring', 'offline')).toBe('awaiting-runner');
  });

  test('unknown runner status is treated as online (no offline flicker)', () => {
    expect(renderPhaseFromState('spawning', 'unknown')).toBe('spawning');
  });

  test('awaitingSessionsCheck maps to awaiting-sessions', () => {
    expect(renderPhaseFromState('awaitingSessionsCheck', 'online')).toBe('awaiting-sessions');
  });

  test('all spawn-prerequisite states collapse to spawning', () => {
    expect(renderPhaseFromState('awaitingPanelVisible', 'online')).toBe('spawning');
    expect(renderPhaseFromState('awaitingSocketSpawn', 'online')).toBe('spawning');
    expect(renderPhaseFromState('spawning', 'online')).toBe('spawning');
  });

  test('restore prerequisite + restoring both collapse to restoring', () => {
    expect(renderPhaseFromState('awaitingSocketRestore', 'online')).toBe('restoring');
    expect(renderPhaseFromState('restoring', 'online')).toBe('restoring');
  });
});
