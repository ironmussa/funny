import type { ThreadWithMessages } from '@funny/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findProviderAuthError,
  ProviderAuthRecovery,
} from '@/components/thread/ProviderAuthRecovery';

const state = vi.hoisted(() => ({ threadDataById: {} as Record<string, unknown> }));
vi.mock('@/stores/thread-store', () => ({
  useThreadStore: (select: (s: typeof state) => unknown) => select(state),
}));
vi.mock('@/components/ProviderSetupDialog', () => ({
  ProviderSetupDialog: ({ provider, projectId, reauthenticate, onClose }: any) => (
    <div
      role="dialog"
      data-provider={provider}
      data-project={projectId}
      data-reauth={reauthenticate}
    >
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

afterEach(cleanup);
const failure = (error: string) =>
  ({
    id: 't1',
    provider: 'claude',
    projectId: 'p1',
    messages: [
      { id: 'u1', role: 'user', timestamp: '2026-01-01T00:00:00Z' },
      {
        id: 'a1',
        role: 'assistant',
        timestamp: '2026-01-01T00:00:01Z',
        toolCalls: [{ id: 'error1', name: 'ProviderError', input: JSON.stringify({ error }) }],
      },
    ],
  }) as ThreadWithMessages;
const expired = 'Failed to authenticate: OAuth session expired and could not be refreshed';

describe('provider authentication recovery', () => {
  it('recognizes an expired OAuth session but ignores unrelated provider errors', () => {
    expect(findProviderAuthError(failure(expired))).toBe('error1');
    expect(findProviderAuthError(failure('Rate limit exceeded'))).toBeUndefined();
    expect(findProviderAuthError(failure('Network timeout'))).toBeUndefined();
  });
  it('ignores previous turns including when the newest user message is outside the loaded window', () => {
    const thread = failure(expired);
    thread.lastUserMessage = { ...thread.messages[0], id: 'u2', timestamp: '2026-01-02T00:00:00Z' };
    expect(findProviderAuthError(thread)).toBeUndefined();
    thread.messages.push(thread.lastUserMessage);
    expect(findProviderAuthError(thread)).toBeUndefined();
  });
  it('opens the correct provider and project, supports dismissal and reopening', () => {
    state.threadDataById = { t1: failure(expired) };
    const { rerender } = render(<ProviderAuthRecovery threadId="t1" />);
    expect(screen.getByRole('dialog').getAttribute('data-project')).toBe('p1');
    expect(screen.getByRole('dialog').getAttribute('data-provider')).toBe('claude');
    expect(screen.getByRole('dialog').getAttribute('data-reauth')).toBe('true');
    fireEvent.click(screen.getByText('Close'));
    rerender(<ProviderAuthRecovery threadId="t1" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('does not open for another thread or a non-authentication error', () => {
    state.threadDataById = { t1: failure('Rate limit exceeded') };
    render(<ProviderAuthRecovery threadId="t1" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
