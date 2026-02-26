import { describe, test, expect, beforeEach } from 'bun:test';

import { AgentStateTracker } from '../../services/agent-state.js';

/**
 * Tests for AgentStateTracker.
 *
 * AgentStateTracker is a pure in-memory class with no database dependencies,
 * so we can test it directly without mocking.
 */

describe('AgentStateTracker', () => {
  let tracker: AgentStateTracker;

  beforeEach(() => {
    tracker = new AgentStateTracker();
  });

  // ── Initial state ──────────────────────────────────────────────

  describe('initial state', () => {
    test('starts with empty resultReceived set', () => {
      expect(tracker.resultReceived.size).toBe(0);
    });

    test('starts with empty currentAssistantMsgId map', () => {
      expect(tracker.currentAssistantMsgId.size).toBe(0);
    });

    test('starts with empty processedToolUseIds map', () => {
      expect(tracker.processedToolUseIds.size).toBe(0);
    });

    test('starts with empty cliToDbMsgId map', () => {
      expect(tracker.cliToDbMsgId.size).toBe(0);
    });

    test('starts with empty pendingUserInput map', () => {
      expect(tracker.pendingUserInput.size).toBe(0);
    });

    test('starts with empty pendingPermissionRequest map', () => {
      expect(tracker.pendingPermissionRequest.size).toBe(0);
    });
  });

  // ── resultReceived ─────────────────────────────────────────────

  describe('resultReceived', () => {
    test('can add and check thread IDs', () => {
      tracker.resultReceived.add('thread-1');
      expect(tracker.resultReceived.has('thread-1')).toBe(true);
      expect(tracker.resultReceived.has('thread-2')).toBe(false);
    });

    test('can add multiple thread IDs', () => {
      tracker.resultReceived.add('thread-1');
      tracker.resultReceived.add('thread-2');
      tracker.resultReceived.add('thread-3');
      expect(tracker.resultReceived.size).toBe(3);
    });

    test('adding the same thread ID twice is a no-op', () => {
      tracker.resultReceived.add('thread-1');
      tracker.resultReceived.add('thread-1');
      expect(tracker.resultReceived.size).toBe(1);
    });
  });

  // ── currentAssistantMsgId ──────────────────────────────────────

  describe('currentAssistantMsgId', () => {
    test('can set and get assistant message ID for a thread', () => {
      tracker.currentAssistantMsgId.set('thread-1', 'msg-abc');
      expect(tracker.currentAssistantMsgId.get('thread-1')).toBe('msg-abc');
    });

    test('returns undefined for unknown thread', () => {
      expect(tracker.currentAssistantMsgId.get('unknown')).toBeUndefined();
    });

    test('can overwrite existing value', () => {
      tracker.currentAssistantMsgId.set('thread-1', 'msg-old');
      tracker.currentAssistantMsgId.set('thread-1', 'msg-new');
      expect(tracker.currentAssistantMsgId.get('thread-1')).toBe('msg-new');
    });

    test('different threads have independent message IDs', () => {
      tracker.currentAssistantMsgId.set('thread-1', 'msg-1');
      tracker.currentAssistantMsgId.set('thread-2', 'msg-2');
      expect(tracker.currentAssistantMsgId.get('thread-1')).toBe('msg-1');
      expect(tracker.currentAssistantMsgId.get('thread-2')).toBe('msg-2');
    });
  });

  // ── processedToolUseIds ────────────────────────────────────────

  describe('processedToolUseIds', () => {
    test('can store nested map per thread', () => {
      const threadMap = new Map<string, string>();
      threadMap.set('cli-tool-use-1', 'db-tc-1');
      threadMap.set('cli-tool-use-2', 'db-tc-2');
      tracker.processedToolUseIds.set('thread-1', threadMap);

      expect(tracker.processedToolUseIds.has('thread-1')).toBe(true);
      expect(tracker.processedToolUseIds.get('thread-1')!.get('cli-tool-use-1')).toBe('db-tc-1');
      expect(tracker.processedToolUseIds.get('thread-1')!.get('cli-tool-use-2')).toBe('db-tc-2');
    });

    test('different threads have independent maps', () => {
      const map1 = new Map([['id-a', 'tc-a']]);
      const map2 = new Map([['id-b', 'tc-b']]);
      tracker.processedToolUseIds.set('thread-1', map1);
      tracker.processedToolUseIds.set('thread-2', map2);

      expect(tracker.processedToolUseIds.get('thread-1')!.has('id-b')).toBe(false);
      expect(tracker.processedToolUseIds.get('thread-2')!.has('id-a')).toBe(false);
    });
  });

  // ── cliToDbMsgId ───────────────────────────────────────────────

  describe('cliToDbMsgId', () => {
    test('can store CLI to DB message ID mapping per thread', () => {
      const threadMap = new Map<string, string>();
      threadMap.set('cli-msg-1', 'db-msg-1');
      tracker.cliToDbMsgId.set('thread-1', threadMap);

      expect(tracker.cliToDbMsgId.get('thread-1')!.get('cli-msg-1')).toBe('db-msg-1');
    });

    test('returns undefined for unknown thread', () => {
      expect(tracker.cliToDbMsgId.get('unknown')).toBeUndefined();
    });
  });

  // ── pendingUserInput ───────────────────────────────────────────

  describe('pendingUserInput', () => {
    test('can set and get waiting reason for a thread', () => {
      tracker.pendingUserInput.set('thread-1', 'question');
      expect(tracker.pendingUserInput.get('thread-1')).toBe('question');
    });

    test('supports all WaitingReason values', () => {
      tracker.pendingUserInput.set('thread-q', 'question');
      tracker.pendingUserInput.set('thread-p', 'plan');
      tracker.pendingUserInput.set('thread-perm', 'permission');

      expect(tracker.pendingUserInput.get('thread-q')).toBe('question');
      expect(tracker.pendingUserInput.get('thread-p')).toBe('plan');
      expect(tracker.pendingUserInput.get('thread-perm')).toBe('permission');
    });

    test('can overwrite waiting reason', () => {
      tracker.pendingUserInput.set('thread-1', 'question');
      tracker.pendingUserInput.set('thread-1', 'plan');
      expect(tracker.pendingUserInput.get('thread-1')).toBe('plan');
    });
  });

  // ── pendingPermissionRequest ───────────────────────────────────

  describe('pendingPermissionRequest', () => {
    test('can set and get permission request for a thread', () => {
      tracker.pendingPermissionRequest.set('thread-1', {
        toolName: 'Bash',
        toolUseId: 'tool-use-123',
      });

      const request = tracker.pendingPermissionRequest.get('thread-1');
      expect(request).toBeTruthy();
      expect(request!.toolName).toBe('Bash');
      expect(request!.toolUseId).toBe('tool-use-123');
    });

    test('returns undefined for thread without pending permission', () => {
      expect(tracker.pendingPermissionRequest.get('unknown')).toBeUndefined();
    });

    test('different threads can have different pending permissions', () => {
      tracker.pendingPermissionRequest.set('thread-1', { toolName: 'Bash', toolUseId: 'tu-1' });
      tracker.pendingPermissionRequest.set('thread-2', { toolName: 'Write', toolUseId: 'tu-2' });

      expect(tracker.pendingPermissionRequest.get('thread-1')!.toolName).toBe('Bash');
      expect(tracker.pendingPermissionRequest.get('thread-2')!.toolName).toBe('Write');
    });
  });

  // ── clearRunState ──────────────────────────────────────────────

  describe('clearRunState', () => {
    test('clears currentAssistantMsgId for the thread', () => {
      tracker.currentAssistantMsgId.set('thread-1', 'msg-1');
      tracker.currentAssistantMsgId.set('thread-2', 'msg-2');

      tracker.clearRunState('thread-1');

      expect(tracker.currentAssistantMsgId.has('thread-1')).toBe(false);
      expect(tracker.currentAssistantMsgId.get('thread-2')).toBe('msg-2');
    });

    test('clears resultReceived for the thread', () => {
      tracker.resultReceived.add('thread-1');
      tracker.resultReceived.add('thread-2');

      tracker.clearRunState('thread-1');

      expect(tracker.resultReceived.has('thread-1')).toBe(false);
      expect(tracker.resultReceived.has('thread-2')).toBe(true);
    });

    test('clears pendingUserInput for the thread', () => {
      tracker.pendingUserInput.set('thread-1', 'question');
      tracker.pendingUserInput.set('thread-2', 'plan');

      tracker.clearRunState('thread-1');

      expect(tracker.pendingUserInput.has('thread-1')).toBe(false);
      expect(tracker.pendingUserInput.get('thread-2')).toBe('plan');
    });

    test('does NOT clear processedToolUseIds (preserved across sessions)', () => {
      const map = new Map([['cli-1', 'db-1']]);
      tracker.processedToolUseIds.set('thread-1', map);

      tracker.clearRunState('thread-1');

      expect(tracker.processedToolUseIds.has('thread-1')).toBe(true);
      expect(tracker.processedToolUseIds.get('thread-1')!.get('cli-1')).toBe('db-1');
    });

    test('does NOT clear cliToDbMsgId (preserved across sessions)', () => {
      const map = new Map([['cli-msg-1', 'db-msg-1']]);
      tracker.cliToDbMsgId.set('thread-1', map);

      tracker.clearRunState('thread-1');

      expect(tracker.cliToDbMsgId.has('thread-1')).toBe(true);
      expect(tracker.cliToDbMsgId.get('thread-1')!.get('cli-msg-1')).toBe('db-msg-1');
    });

    test('does NOT clear pendingPermissionRequest', () => {
      tracker.pendingPermissionRequest.set('thread-1', { toolName: 'Bash', toolUseId: 'tu-1' });

      tracker.clearRunState('thread-1');

      // pendingPermissionRequest is not cleared by clearRunState
      expect(tracker.pendingPermissionRequest.has('thread-1')).toBe(true);
    });

    test('clearRunState on non-existent thread does not throw', () => {
      expect(() => tracker.clearRunState('nonexistent')).not.toThrow();
    });

    test('clearRunState is idempotent', () => {
      tracker.currentAssistantMsgId.set('thread-1', 'msg-1');
      tracker.resultReceived.add('thread-1');

      tracker.clearRunState('thread-1');
      tracker.clearRunState('thread-1');

      expect(tracker.currentAssistantMsgId.has('thread-1')).toBe(false);
      expect(tracker.resultReceived.has('thread-1')).toBe(false);
    });
  });

  // ── cleanupThread ──────────────────────────────────────────────

  describe('cleanupThread', () => {
    test('removes ALL state for a thread', () => {
      // Populate all state for thread-1
      tracker.resultReceived.add('thread-1');
      tracker.currentAssistantMsgId.set('thread-1', 'msg-1');
      tracker.processedToolUseIds.set('thread-1', new Map([['cli-1', 'db-1']]));
      tracker.cliToDbMsgId.set('thread-1', new Map([['cli-msg', 'db-msg']]));
      tracker.pendingUserInput.set('thread-1', 'question');
      tracker.pendingPermissionRequest.set('thread-1', { toolName: 'Bash', toolUseId: 'tu-1' });

      tracker.cleanupThread('thread-1');

      expect(tracker.resultReceived.has('thread-1')).toBe(false);
      expect(tracker.currentAssistantMsgId.has('thread-1')).toBe(false);
      expect(tracker.processedToolUseIds.has('thread-1')).toBe(false);
      expect(tracker.cliToDbMsgId.has('thread-1')).toBe(false);
      expect(tracker.pendingUserInput.has('thread-1')).toBe(false);
      expect(tracker.pendingPermissionRequest.has('thread-1')).toBe(false);
    });

    test('does not affect other threads', () => {
      // Populate state for both threads
      tracker.resultReceived.add('thread-1');
      tracker.resultReceived.add('thread-2');
      tracker.currentAssistantMsgId.set('thread-1', 'msg-1');
      tracker.currentAssistantMsgId.set('thread-2', 'msg-2');
      tracker.processedToolUseIds.set('thread-1', new Map([['a', 'b']]));
      tracker.processedToolUseIds.set('thread-2', new Map([['c', 'd']]));
      tracker.cliToDbMsgId.set('thread-1', new Map([['x', 'y']]));
      tracker.cliToDbMsgId.set('thread-2', new Map([['w', 'z']]));
      tracker.pendingUserInput.set('thread-1', 'question');
      tracker.pendingUserInput.set('thread-2', 'plan');
      tracker.pendingPermissionRequest.set('thread-1', { toolName: 'Bash', toolUseId: '1' });
      tracker.pendingPermissionRequest.set('thread-2', { toolName: 'Write', toolUseId: '2' });

      tracker.cleanupThread('thread-1');

      // thread-2 state should be intact
      expect(tracker.resultReceived.has('thread-2')).toBe(true);
      expect(tracker.currentAssistantMsgId.get('thread-2')).toBe('msg-2');
      expect(tracker.processedToolUseIds.get('thread-2')!.get('c')).toBe('d');
      expect(tracker.cliToDbMsgId.get('thread-2')!.get('w')).toBe('z');
      expect(tracker.pendingUserInput.get('thread-2')).toBe('plan');
      expect(tracker.pendingPermissionRequest.get('thread-2')!.toolName).toBe('Write');
    });

    test('cleanupThread on non-existent thread does not throw', () => {
      expect(() => tracker.cleanupThread('nonexistent')).not.toThrow();
    });

    test('cleanupThread is idempotent', () => {
      tracker.resultReceived.add('thread-1');
      tracker.currentAssistantMsgId.set('thread-1', 'msg-1');

      tracker.cleanupThread('thread-1');
      tracker.cleanupThread('thread-1');

      expect(tracker.resultReceived.has('thread-1')).toBe(false);
      expect(tracker.currentAssistantMsgId.has('thread-1')).toBe(false);
    });
  });

  // ── clearRunState vs cleanupThread comparison ──────────────────

  describe('clearRunState vs cleanupThread', () => {
    test('clearRunState preserves session-resume state, cleanupThread removes everything', () => {
      // Set up all state
      tracker.resultReceived.add('thread-1');
      tracker.currentAssistantMsgId.set('thread-1', 'msg-1');
      tracker.processedToolUseIds.set('thread-1', new Map([['cli-1', 'db-1']]));
      tracker.cliToDbMsgId.set('thread-1', new Map([['cli-msg', 'db-msg']]));
      tracker.pendingUserInput.set('thread-1', 'question');

      // clearRunState preserves processedToolUseIds and cliToDbMsgId
      tracker.clearRunState('thread-1');
      expect(tracker.processedToolUseIds.has('thread-1')).toBe(true);
      expect(tracker.cliToDbMsgId.has('thread-1')).toBe(true);

      // cleanupThread removes everything
      tracker.cleanupThread('thread-1');
      expect(tracker.processedToolUseIds.has('thread-1')).toBe(false);
      expect(tracker.cliToDbMsgId.has('thread-1')).toBe(false);
    });
  });

  // ── Multiple tracker instances are independent ─────────────────

  describe('multiple instances', () => {
    test('two tracker instances do not share state', () => {
      const tracker2 = new AgentStateTracker();

      tracker.resultReceived.add('thread-1');
      tracker.currentAssistantMsgId.set('thread-1', 'msg-1');

      expect(tracker2.resultReceived.has('thread-1')).toBe(false);
      expect(tracker2.currentAssistantMsgId.has('thread-1')).toBe(false);
    });
  });
});
