import { describe, expect, mock, test } from 'bun:test';

import { fireEvent, render, screen } from '@testing-library/react';

import { ThinkCard } from '@/components/tool-cards/ThinkCard';

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('ThinkCard', () => {
  test('is collapsed by default and expands on click', () => {
    const { container } = render(
      <ThinkCard parsed={{ content: 'step by step reasoning' }} displayTime="1m ago" />,
    );

    const card = container.firstElementChild!;
    const button = screen.getByRole('button', { name: /tools\.thinking/i });

    expect(card).toHaveAttribute('data-expanded', 'false');
    expect(card.className).toContain('tool-card-frame');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('think-card-preview')).toHaveTextContent('step by step reasoning');
    expect(screen.queryByTestId('think-card-content')).not.toBeInTheDocument();

    fireEvent.click(button);

    expect(card).toHaveAttribute('data-expanded', 'true');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('think-card-preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('think-card-content')).toBeInTheDocument();

    fireEvent.click(button);

    expect(card).toHaveAttribute('data-expanded', 'false');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('think-card-preview')).toHaveTextContent('step by step reasoning');
    expect(screen.queryByTestId('think-card-content')).not.toBeInTheDocument();
  });

  test('strips markdown and collapses newlines in the collapsed preview', () => {
    render(
      <ThinkCard
        parsed={{
          content: '**Investigating sidebar**\n\n- Check `ThinkCard.tsx`\n- Verify tests',
        }}
      />,
    );

    expect(screen.getByTestId('think-card-preview')).toHaveTextContent(
      'Investigating sidebar Check ThinkCard.tsx Verify tests',
    );
  });

  test('renders nothing when there is no thinking content', () => {
    const { container } = render(<ThinkCard parsed={{}} />);
    expect(container.firstChild).toBeNull();
  });
});
