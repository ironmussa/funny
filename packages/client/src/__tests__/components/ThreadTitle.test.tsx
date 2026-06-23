import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('ThreadTitle', () => {
  test('does not capitalize URL titles', () => {
    render(<ThreadTitle title="https://linear.app/goliiive-v3/issue/GOL-773/example" />);

    expect(
      screen.getByText('https://linear.app/goliiive-v3/issue/GOL-773/example'),
    ).not.toHaveClass('first-letter:uppercase');
  });

  test('keeps capitalizing normal prose titles', () => {
    render(<ThreadTitle title="fix the linear issue" />);

    expect(screen.getByText('fix the linear issue')).toHaveClass('first-letter:uppercase');
  });
});
