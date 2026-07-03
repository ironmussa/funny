import { render, screen } from '@testing-library/react';
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
});
