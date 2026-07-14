import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { MessageStreamStatusTail } from '@/components/thread/MessageStreamStatusTail';

const baseProps = {
  status: 'idle',
  isRunning: false,
  isExternal: false,
  compact: false,
  model: 'test-model',
  permissionMode: 'default',
  t: ((key: string, fallback?: string) => fallback ?? key) as any,
  onSend: vi.fn(),
  onPermissionApprove: vi.fn(),
  onPermissionAlwaysAllow: vi.fn(),
  onPermissionDeny: vi.fn(),
};

describe('MessageStreamStatusTail', () => {
  test('renders running externally as a static status', () => {
    const { container } = render(
      <MessageStreamStatusTail {...baseProps} status="running" isRunning isExternal />,
    );

    expect(screen.getByText('Running externally...')).toBeInTheDocument();
    expect(container.querySelector('[class*="animate-"]')).toBeNull();
  });

  test('renders waiting for response without pulse animation', () => {
    const { container } = render(
      <MessageStreamStatusTail {...baseProps} status="waiting" waitingReason="question" />,
    );

    expect(screen.getByText('thread.waitingForResponse')).toBeInTheDocument();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  test('keeps a structured request actionable after its always decision fails', async () => {
    const onPermissionDecision = vi.fn().mockRejectedValue(new Error('rule persistence failed'));
    render(
      <MessageStreamStatusTail
        {...baseProps}
        status="waiting"
        waitingReason="permission"
        permissionApprovalCapability={{
          kind: 'structured',
          transport: 'codex-acp',
        }}
        pendingPermissionRequest={{
          requestId: '7dc36c85-8577-4b86-83f5-872392d331ed',
          threadId: 'thread-1',
          runId: 'run-1',
          transport: 'codex-acp',
          toolCallId: 'tool-1',
          toolName: 'Bash',
          toolInput: '{"command":"git status"}',
          canAlwaysAllow: true,
          canDeny: true,
          requestedAt: '2026-07-13T00:00:00.000Z',
        }}
        onPermissionDecision={onPermissionDecision}
      />,
    );

    const always = screen.getByTestId('permission-approve-always');
    fireEvent.click(always);
    await waitFor(() =>
      expect(onPermissionDecision).toHaveBeenCalledWith(
        '7dc36c85-8577-4b86-83f5-872392d331ed',
        'allow_always',
      ),
    );
    await waitFor(() => expect(screen.getByTestId('permission-approve-once')).not.toBeDisabled());
  });

  test('explains a lost ACP continuation without rendering an approval card', () => {
    render(
      <MessageStreamStatusTail
        {...baseProps}
        status="waiting"
        waitingReason="provider_error"
        permissionRecoveryReason="runner_lost"
        permissionApprovalCapability={{
          kind: 'unavailable',
          reason: 'codex-sdk-no-interactive-approval',
        }}
      />,
    );

    expect(screen.getByTestId('permission-continuation-lost')).toBeInTheDocument();
    expect(screen.queryByTestId('permission-approve-once')).not.toBeInTheDocument();
    expect(screen.queryByTestId('codex-sdk-approval-unavailable')).not.toBeInTheDocument();
  });
});
