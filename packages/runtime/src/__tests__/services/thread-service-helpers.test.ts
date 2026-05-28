import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { emit: vi.fn(), emitToUser: vi.fn() },
}));

import {
  stripReferencedFilesBlock,
  slugifyTitle,
  createSetupProgressEmitter,
  emitThreadUpdated,
  emitAgentFailed,
} from '../../services/thread-service/helpers.js';
import { wsBroker } from '../../services/ws-broker.js';

describe('thread-service helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('stripReferencedFilesBlock', () => {
    test('removes a leading referenced-files XML block', () => {
      const input = '<referenced-files><file path="a.ts"/></referenced-files>\nDo the thing';
      expect(stripReferencedFilesBlock(input)).toBe('Do the thing');
    });

    test('returns trimmed text when no block is present', () => {
      expect(stripReferencedFilesBlock('  plain prompt  ')).toBe('plain prompt');
    });
  });

  describe('slugifyTitle', () => {
    test('lowercases and hyphenates words', () => {
      expect(slugifyTitle('Fix Login Bug!')).toBe('fix-login-bug');
    });

    test('falls back to thread when title has no slug characters', () => {
      expect(slugifyTitle('!!!')).toBe('thread');
    });

    test('respects maxLength', () => {
      expect(slugifyTitle('abcdefghijklmnop', 5)).toBe('abcde');
    });
  });

  describe('WS emitters', () => {
    test('createSetupProgressEmitter forwards worktree setup events', () => {
      const emit = createSetupProgressEmitter('user-1', 'thread-1');
      emit('clone', 'Cloning repo', 'running');

      expect(wsBroker.emitToUser).toHaveBeenCalledWith('user-1', {
        type: 'worktree:setup',
        threadId: 'thread-1',
        data: { step: 'clone', label: 'Cloning repo', status: 'running', error: undefined },
      });
    });

    test('emitThreadUpdated sends thread:updated', () => {
      emitThreadUpdated('user-1', 'thread-1', { status: 'running' });

      expect(wsBroker.emitToUser).toHaveBeenCalledWith('user-1', {
        type: 'thread:updated',
        threadId: 'thread-1',
        data: { status: 'running' },
      });
    });

    test('emitAgentFailed drops event when userId is missing', () => {
      emitAgentFailed('', 'thread-1');
      expect(wsBroker.emitToUser).not.toHaveBeenCalled();
    });

    test('emitAgentFailed notifies user of failed status', () => {
      emitAgentFailed('user-1', 'thread-1');
      expect(wsBroker.emitToUser).toHaveBeenCalledWith('user-1', {
        type: 'agent:status',
        threadId: 'thread-1',
        data: { status: 'failed' },
      });
    });
  });
});
