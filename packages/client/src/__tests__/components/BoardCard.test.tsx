/**
 * A board card's status glyph follows the theme like a sidebar thread row: a
 * dot theme (Minimal) swaps icons for dots only inside `.status-glyph-dots`,
 * and the factory board showed icons while the sidebar showed dots.
 */
import { describe, expect, test } from 'bun:test';

import { render, screen } from '@testing-library/react';

import { BoardCard } from '@/components/board/BoardCard';

describe('BoardCard', () => {
  test('its status glyph sits where a dot theme shows dots', () => {
    render(
      <BoardCard
        testId="card"
        onOpen={() => {}}
        status={<span data-testid="glyph" />}
        title="Title"
        time="1m"
      />,
    );
    expect(screen.getByTestId('glyph').closest('.status-glyph-dots')).not.toBeNull();
  });

  test('the title spans the card: the time and the secondary facts share the footer line', () => {
    render(
      <BoardCard
        testId="card"
        onOpen={() => {}}
        status={<span />}
        title={<span data-testid="title">Title</span>}
        footer={<span data-testid="fact">funny</span>}
        time="1m"
      />,
    );
    const footer = screen.getByTestId('card-footer');
    expect(footer.textContent).toBe('funny1m');
    expect(footer.contains(screen.getByTestId('title'))).toBe(false);
    // Nothing but the status glyph shares the title's row.
    expect(screen.getByTestId('title').parentElement?.parentElement?.children.length).toBe(2);
  });
});
