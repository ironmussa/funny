import type { Thread } from '@funny/shared';
import { screen } from '@testing-library/react';
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
});
