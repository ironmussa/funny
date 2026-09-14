import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, afterAll, describe, expect, test, vi } from 'vitest';

import { HistoryFilters } from '@/components/commit-graph/HistoryFilters';

import { renderWithProviders } from '../helpers/render';

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterAll(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

const onOpen = vi.fn();
function FilterHarness() {
  const [authors, setAuthors] = useState<string[]>([]);
  return (
    <HistoryFilters
      allBranches={true}
      onToggleAllBranches={() => {}}
      syncFilter="all"
      onToggleSyncFilter={() => {}}
      authors={authors}
      onAuthorsChange={setAuthors}
      onAuthorOpenChange={onOpen}
      authorOptions={[
        { value: 'alice@example.com', label: 'Alice <alice@example.com>' },
        { value: 'bob@example.com', label: 'Bob <bob@example.com>' },
      ]}
    />
  );
}

describe('HistoryFilters', () => {
  test('loads the author list on open, searches options, supports multiple selections and clears', async () => {
    renderWithProviders(<FilterHarness />);
    fireEvent.click(screen.getByTestId('graph-filter-author'));
    expect(onOpen).toHaveBeenCalledWith(true);
    const alice = await screen.findByTestId('graph-filter-author-option-alice@example.com');
    fireEvent.click(alice);
    fireEvent.click(screen.getByTestId('graph-filter-author-option-bob@example.com'));
    expect(screen.getByTestId('graph-filter-author')).toHaveTextContent('2');
    fireEvent.change(screen.getByTestId('graph-filter-author-search'), {
      target: { value: 'bob@' },
    });
    expect(
      screen.queryByTestId('graph-filter-author-option-alice@example.com'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('graph-filter-author-option-bob@example.com')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('graph-filter-author-search'), { key: 'Escape' });
    fireEvent.click(screen.getByTestId('graph-filter-clear'));
    expect(screen.getByTestId('graph-filter-author')).toHaveTextContent(/^Author$/);
  });
});
