import type { Thread } from '@funny/shared';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ThreadItem } from '@/components/sidebar/ThreadItem';

import { mockT } from '../../helpers/mock-i18n';
import { renderWithProviders } from '../../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'scratch-1',
    projectId: '',
    isScratch: true,
    title: 'Try a regex',
    status: 'pending',
    mode: 'local',
    provider: 'claude',
    permissionMode: 'autoEdit',
    model: 'sonnet',
    cost: 0,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  } as Thread;
}

describe('ThreadItem', () => {
  test('shows a pending scratch thread as launching instead of ready to launch', () => {
    renderWithProviders(
      <ThreadItem thread={makeThread()} projectPath="" isSelected={false} onSelect={vi.fn()} />,
    );

    expect(screen.getByTestId('thread-item-scratch-1')).toHaveTextContent('Launching...');
    expect(screen.queryByText('Ready to Launch')).not.toBeInTheDocument();
  });

  test('renders the pin control beside the thread selection button', () => {
    const { container } = renderWithProviders(
      <ThreadItem
        thread={makeThread({ pinned: true, status: 'idle' })}
        projectPath=""
        isSelected={false}
        onSelect={vi.fn()}
        onPin={vi.fn()}
      />,
    );

    const threadButton = screen.getByTestId('thread-item-scratch-1');
    const pinButton = screen.getByTestId('thread-pin-toggle-scratch-1');

    expect(threadButton).not.toContainElement(pinButton);
    expect(container.querySelector('button button')).not.toBeInTheDocument();
  });

  test('does not commit a rename while Enter confirms an IME composition', async () => {
    const onRename = vi.fn();
    renderWithProviders(
      <ThreadItem
        thread={makeThread({ status: 'idle' })}
        projectPath=""
        isSelected={false}
        onSelect={vi.fn()}
        onRename={onRename}
      />,
    );

    fireEvent.pointerDown(screen.getByTestId('thread-item-more-scratch-1'), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByTestId('thread-rename-scratch-1'));
    const input = screen.getByTestId('thread-rename-input-scratch-1');
    fireEvent.change(input, { target: { value: 'Renamed thread' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onRename).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();
  });
});
