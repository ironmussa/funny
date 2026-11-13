import type { Thread } from '@funny/shared';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { KanbanColumn } from '@/components/kanban/KanbanColumn';

vi.mock('@atlaskit/pragmatic-drag-and-drop-auto-scroll/element', () => ({
  autoScrollForElements: () => vi.fn(),
}));
vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  dropTargetForElements: () => vi.fn(),
}));
vi.mock('@/components/kanban/AddThreadButton', () => ({
  AddThreadButton: () => null,
}));
vi.mock('@/components/kanban/KanbanCard', () => ({
  KanbanCard: ({ thread }: { thread: Thread }) => (
    <div data-testid="kanban-test-card">{thread.id}</div>
  ),
}));

const threads = Array.from({ length: 45 }, (_, index) => ({
  id: `thread-${index}`,
  projectId: 'project-1',
})) as Thread[];

const baseProps = {
  stage: 'backlog' as const,
  threads,
  onDelete: vi.fn(),
  onArchive: vi.fn(),
  projectId: 'project-1',
  projects: [],
  onAddThread: vi.fn(),
  statusByThread: {},
};

/** Observers the load-more sentinel created; `scrollToEnd` reports it in view. */
let intersectionCallbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
function scrollToEnd() {
  act(() => {
    for (const callback of intersectionCallbacks) callback([{ isIntersecting: true }]);
  });
}

describe('KanbanColumn pagination', () => {
  beforeEach(() => {
    intersectionCallbacks = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
          intersectionCallbacks.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  test('resets pagination for a new search and expands to a highlighted thread', () => {
    const view = render(<KanbanColumn {...baseProps} />);
    expect(screen.getAllByTestId('kanban-test-card')).toHaveLength(20);

    scrollToEnd();
    expect(screen.getAllByTestId('kanban-test-card')).toHaveLength(40);

    view.rerender(<KanbanColumn {...baseProps} search="new query" />);
    expect(screen.getAllByTestId('kanban-test-card')).toHaveLength(20);

    view.rerender(<KanbanColumn {...baseProps} search="new query" highlightThreadId="thread-35" />);
    expect(screen.getAllByTestId('kanban-test-card')).toHaveLength(36);
  });
  test('passes search settings to a custom card renderer', () => {
    const card = vi.fn(({ thread }: { thread: Thread; caseSensitive?: boolean }) => (
      <div>{thread.id}</div>
    ));
    render(
      <KanbanColumn
        {...baseProps}
        threads={[threads[0]]}
        search="Exact"
        caseSensitive
        cardComponent={card}
      />,
    );
    expect(card.mock.calls[0]?.[0]).toMatchObject({
      thread: threads[0],
      search: 'Exact',
      caseSensitive: true,
      stage: 'backlog',
    });
  });
});
