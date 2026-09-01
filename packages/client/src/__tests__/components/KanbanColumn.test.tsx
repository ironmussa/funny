import type { Thread } from '@funny/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

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

describe('KanbanColumn pagination', () => {
  test('resets pagination for a new search and expands to a highlighted thread', () => {
    const view = render(<KanbanColumn {...baseProps} />);
    expect(screen.getAllByTestId('kanban-test-card')).toHaveLength(20);

    fireEvent.click(screen.getByTestId('kanban-load-more-backlog'));
    expect(screen.getAllByTestId('kanban-test-card')).toHaveLength(40);

    view.rerender(<KanbanColumn {...baseProps} search="new query" />);
    expect(screen.getAllByTestId('kanban-test-card')).toHaveLength(20);

    view.rerender(<KanbanColumn {...baseProps} search="new query" highlightThreadId="thread-35" />);
    expect(screen.getAllByTestId('kanban-test-card')).toHaveLength(36);
  });
});
