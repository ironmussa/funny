import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ThreadSearchBar } from '@/components/thread/ThreadSearchBar';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('ThreadSearchBar', () => {
  test('removes previous highlights immediately when the query changes', () => {
    const onClearHighlights = vi.fn();

    renderWithProviders(
      <ThreadSearchBar
        threadId="thread-1"
        open
        onClose={vi.fn()}
        onNavigateToMessage={vi.fn()}
        onClearHighlights={onClearHighlights}
      />,
    );

    fireEvent.change(screen.getByTestId('thread-search-input'), {
      target: { value: 'no-match' },
    });

    expect(onClearHighlights).toHaveBeenCalledOnce();
  });
});
