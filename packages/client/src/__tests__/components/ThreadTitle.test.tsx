import { screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('ThreadTitle', () => {
  test('does not capitalize URL titles', () => {
    renderWithProviders(
      <ThreadTitle title="https://example.com/goliiive-v3/issue/GOL-773/example" />,
    );

    expect(
      screen.getByText('https://example.com/goliiive-v3/issue/GOL-773/example'),
    ).not.toHaveClass('first-letter:uppercase');
  });

  test('keeps capitalizing normal prose titles', () => {
    renderWithProviders(<ThreadTitle title="fix the linear issue" />);

    expect(screen.getByText('fix the linear issue')).toHaveClass('first-letter:uppercase');
  });

  test('replaces a Linear issue URL with a compact issue badge', () => {
    renderWithProviders(
      <ThreadTitle title="/fix-linear https://linear.app/goliiive-v3/issue/GOL-728/core-catalogo-publico-con" />,
    );

    expect(screen.getByTestId('thread-title-slash-command')).toHaveTextContent('fix-linear');
    expect(screen.queryByText(/https:\/\/linear\.app/)).not.toBeInTheDocument();
    expect(screen.getByTestId('thread-title-linear-issue')).toHaveTextContent('Linear');
    expect(screen.getByTestId('thread-title-linear-issue')).toHaveTextContent('GOL-728');
  });

  test('uses compact token sizing when requested for sidebar rows', () => {
    renderWithProviders(
      <ThreadTitle
        title="/fix-linear https://linear.app/goliiive-v3/issue/GOL-733/example"
        density="compact"
      />,
    );

    expect(screen.getByTestId('thread-title-slash-command')).toHaveClass('h-4');
    expect(screen.getByTestId('thread-title-linear-issue')).toHaveClass('h-4');
  });

  test('uses title token sizing for the main thread title', () => {
    renderWithProviders(
      <ThreadTitle
        title="/fix-linear https://linear.app/goliiive-v3/issue/GOL-733/example"
        density="title"
      />,
    );

    expect(screen.getByTestId('thread-title-slash-command')).toHaveClass('h-5');
    expect(screen.getByTestId('thread-title-linear-issue')).toHaveClass('h-5');
  });
});
