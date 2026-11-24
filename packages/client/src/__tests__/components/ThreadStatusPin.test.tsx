/**
 * The status glyph every list and board shares (sidebar, thread kanban, factory
 * board). An unread thread shows ONE dot in place of its status icon, never a
 * dot on top of the icon, so a factory board card reads like the sidebar row.
 */
import { describe, expect, test } from 'bun:test';

import { render, screen } from '@testing-library/react';

import { ThreadStatusPin } from '@/components/thread/ThreadStatusPin';
import { buildThread } from '@/data/threads/testing';

const done = '2026-01-02T00:00:00.000Z';

describe('ThreadStatusPin', () => {
  test('an unread completed thread shows a single unread dot instead of its icon', () => {
    render(
      <ThreadStatusPin
        thread={buildThread({ id: 'u1', status: 'completed', completedAt: done })}
        hoverGroup="card"
      />,
    );
    const dot = screen.getByTestId('thread-unread-dot-u1');
    // The dot takes the icon's whole place, and no status icon sits under it.
    expect(dot.className).toContain('inset-0');
    expect(dot.querySelector('svg')).toBeNull();
    expect(dot.parentElement!.querySelectorAll(':scope > span svg').length).toBe(0);
  });

  test('a thread without a completion shows its status icon and no unread dot', () => {
    render(
      <ThreadStatusPin thread={buildThread({ id: 'r1', status: 'waiting' })} hoverGroup="card" />,
    );
    expect(screen.queryByTestId('thread-unread-dot-r1')).toBeNull();
  });

  test('a stopped thread shows the stopped dot', () => {
    render(
      <ThreadStatusPin thread={buildThread({ id: 's1', status: 'stopped' })} hoverGroup="card" />,
    );
    expect(screen.getByTestId('thread-stopped-dot-s1')).toBeTruthy();
  });
});
