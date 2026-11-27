import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { fireEvent, screen } from '@testing-library/react';
import { useEffect } from 'react';

import { GRID_COLS_KEY, GRID_ROWS_KEY } from '@/components/live-columns/grid-constants';
import { GRID_CELLS_KEY } from '@/lib/grid-storage';
import { useUIStore } from '@/stores/ui-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const mountCounts = new Map<string, number>();
const unmountCounts = new Map<string, number>();

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

mock.module('@/components/live-columns/ThreadColumn', () => ({
  ThreadColumn: ({
    threadId,
    cellIndex,
    onRemove,
  }: {
    threadId: string;
    cellIndex: number;
    onRemove?: (cellIndex: number) => void;
  }) => {
    useEffect(() => {
      mountCounts.set(threadId, (mountCounts.get(threadId) ?? 0) + 1);
      return () => {
        unmountCounts.set(threadId, (unmountCounts.get(threadId) ?? 0) + 1);
      };
    }, [threadId]);

    return (
      <div data-testid={`mock-thread-column-${threadId}`}>
        <span>{threadId}</span>
        <button
          type="button"
          data-testid={`mock-remove-${threadId}`}
          onClick={() => onRemove?.(cellIndex)}
        >
          Remove
        </button>
      </div>
    );
  },
}));

mock.module('@/components/live-columns/GridToolbar', () => ({
  GridToolbar: () => <div data-testid="mock-grid-toolbar" />,
}));

mock.module('@/components/live-columns/EmptyGridCell', () => ({
  EmptyGridCell: ({ cellIndex }: { cellIndex: number }) => (
    <div data-testid={`mock-empty-cell-${cellIndex}`} />
  ),
}));

mock.module('@/components/live-columns/ProjectPickerDialog', () => ({
  ProjectPickerDialog: () => null,
}));

mock.module('@/components/ImageLightbox', () => ({
  ImageLightbox: () => null,
}));

mock.module('@/data/git-status/actions', () => ({
  fetchForThread: () => {},
}));

const { LiveColumnsView } = await import('@/components/LiveColumnsView');

describe('LiveColumnsView', () => {
  beforeEach(() => {
    mountCounts.clear();
    unmountCounts.clear();
    localStorage.clear();
    useUIStore.setState({ gridSelectedThreadId: null });
  });

  test('closing a column rearranges remaining columns without remounting their threads', () => {
    localStorage.setItem(GRID_COLS_KEY, '3');
    localStorage.setItem(GRID_ROWS_KEY, '1');
    localStorage.setItem(GRID_CELLS_KEY, JSON.stringify({ '0': 't1', '1': 't2', '2': 't3' }));

    renderWithProviders(<LiveColumnsView />);

    expect(screen.getByTestId('mock-thread-column-t1')).toBeDefined();
    expect(screen.getByTestId('mock-thread-column-t2')).toBeDefined();
    expect(screen.getByTestId('mock-thread-column-t3')).toBeDefined();
    expect(mountCounts.get('t1')).toBe(1);
    expect(mountCounts.get('t2')).toBe(1);
    expect(mountCounts.get('t3')).toBe(1);

    // Close the leftmost column (t1). t2 and t3 shift left into grid-col-0 and grid-col-1.
    fireEvent.click(screen.getByTestId('mock-remove-t1'));

    expect(screen.queryByTestId('mock-thread-column-t1')).toBeNull();
    expect(screen.getByTestId('mock-thread-column-t2')).toBeDefined();
    expect(screen.getByTestId('mock-thread-column-t3')).toBeDefined();

    // Only t1 should have unmounted; t2 and t3 must stay mounted (no refetch/reset).
    expect(unmountCounts.get('t1')).toBe(1);
    expect(unmountCounts.get('t2') ?? 0).toBe(0);
    expect(unmountCounts.get('t3') ?? 0).toBe(0);
    expect(mountCounts.get('t2')).toBe(1);
    expect(mountCounts.get('t3')).toBe(1);
  });
});
