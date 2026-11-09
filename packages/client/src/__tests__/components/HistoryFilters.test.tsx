import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, afterAll, describe, expect, test, vi } from 'vitest';

import { HistoryFilters } from '@/components/commit-graph/HistoryFilters';
import type { GraphBranchScope } from '@/lib/api/git';

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
      branchScope="unmerged"
      onBranchScopeChange={() => {}}
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

  test('opens on unmerged branches and offers all / current, clearing back to unmerged', () => {
    const onScope = vi.fn();
    function ScopeHarness({ initial }: { initial: GraphBranchScope }) {
      const [scope, setScope] = useState<GraphBranchScope>(initial);
      return (
        <HistoryFilters
          branchScope={scope}
          onBranchScopeChange={(next) => {
            onScope(next);
            setScope(next);
          }}
          syncFilter="all"
          onToggleSyncFilter={() => {}}
          authors={[]}
          onAuthorsChange={() => {}}
          onAuthorOpenChange={() => {}}
          authorOptions={[]}
        />
      );
    }
    renderWithProviders(<ScopeHarness initial="all" />);
    expect(screen.getByTestId('graph-toggle-all-branches')).toHaveTextContent('All branches');
    // Not the default scope: Clear resets it to unmerged branches.
    fireEvent.click(screen.getByTestId('graph-filter-clear'));
    expect(onScope).toHaveBeenCalledWith('unmerged');
    expect(screen.getByTestId('graph-toggle-all-branches')).toHaveTextContent('Unmerged branches');
    expect(screen.queryByTestId('graph-filter-clear')).not.toBeInTheDocument();
  });
});
