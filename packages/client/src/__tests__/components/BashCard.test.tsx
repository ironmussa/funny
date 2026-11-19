import { render, screen } from '@testing-library/react';
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
    render(
      <BashCard
        parsed={{ command: { cmd: 'npm', args: ['test'] } }}
        output="tests passed"
        author="shell"
      />,
    );

    expect(screen.getByText(/"cmd": "npm"/)).toBeInTheDocument();
    expect(screen.getByText('tests passed')).toBeInTheDocument();
  });

  test('keeps agent-run command output collapsed by default', () => {
    render(<BashCard parsed={{ command: 'bun test' }} output="tests passed" />);

    expect(screen.getByRole('button', { name: /tools\.runCommand/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByText('tests passed')).not.toBeInTheDocument();
  });

  test('opens shell escape command output by default', () => {
    render(<BashCard parsed={{ command: 'bun test' }} output="tests passed" author="shell" />);

    expect(screen.getByRole('button', { name: /tools\.runCommand/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByText('bun test')).toBeInTheDocument();
    expect(screen.getByText('tests passed')).toBeInTheDocument();
  });
});

describe('BashCard search output', () => {
  test('shows rg output grouped by file', () => {
    render(
      <BashCard
        parsed={{ command: 'rg -n "lint" src' }}
        output={'src/a.ts:4:const lint = 1;\nsrc/a.ts:9:lint();'}
        author="shell"
      />,
    );

    expect(screen.getByTestId('command-output-search')).toBeInTheDocument();
    expect(screen.getAllByText('src/a.ts')).toHaveLength(1);
    expect(screen.getByText('const lint = 1;')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
  });
});
