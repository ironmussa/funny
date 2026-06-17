import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { BashCard } from '@/components/tool-cards/BashCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('BashCard', () => {
  test('renders object-valued commands without throwing', () => {
    render(<BashCard parsed={{ command: { cmd: 'npm', args: ['test'] } }} output="tests passed" />);

    fireEvent.click(screen.getByRole('button', { name: /tools\.runCommand/i }));

    expect(screen.getByText(/"cmd": "npm"/)).toBeInTheDocument();
    expect(screen.getByText('tests passed')).toBeInTheDocument();
  });
});
