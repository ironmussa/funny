import { describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ closeForThread: vi.fn(async () => {}) }));

vi.mock('../../services/browser-session-manager.js', () => ({
  browserSessionManager: { closeForThread: mocks.closeForThread },
}));

import {
  browserSessionThreadArchivedHandler,
  browserSessionThreadDeletedHandler,
} from '../../services/handlers/browser-session-lifecycle-handler.js';

const ctx = {} as any;
const lifecycle = { threadId: 't1', projectId: 'p1', userId: 'u1', worktreePath: null, cwd: '/x' };

describe('browser session lifecycle handlers', () => {
  test('thread deletion closes the thread session', async () => {
    await browserSessionThreadDeletedHandler.action(
      { threadId: 't1', projectId: 'p1', userId: 'u1' },
      ctx,
    );
    expect(mocks.closeForThread).toHaveBeenCalledWith('u1', 't1');
  });

  test('only archiving triggers a close on stage change', () => {
    const filter = browserSessionThreadArchivedHandler.filter!;
    expect(filter({ ...lifecycle, fromStage: 'review', toStage: 'archived' }, ctx)).toBe(true);
    expect(filter({ ...lifecycle, fromStage: 'backlog', toStage: 'in_progress' }, ctx)).toBe(false);
  });
});
