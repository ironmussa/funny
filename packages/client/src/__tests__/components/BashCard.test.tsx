import { describe, expect, test, mock } from 'bun:test';

import { fireEvent, render, screen } from '@testing-library/react';

import { BashCard } from '@/components/tool-cards/BashCard';

mock.module('react-i18next', () => ({
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

// A theme can hide a collapsed card's outline (Minimal sets
// --tool-card-border-color: transparent); an open card always shows it.
test('BashCard marks its container expanded so it keeps a border when open', () => {
  const { container } = render(<BashCard parsed={{ command: 'bun test' }} output="ok" />);
  const card = container.firstElementChild!;
  expect(card).toHaveAttribute('data-expanded', 'false');
  expect(card.className).toContain('tool-card-frame');

  fireEvent.click(screen.getByRole('button', { name: /tools\.runCommand/i }));
  expect(card).toHaveAttribute('data-expanded', 'true');
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
