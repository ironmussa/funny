import type { Virtualizer } from '@tanstack/react-virtual';
import type { RefObject } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';

import { PickerItemRow, type PickerRowHandlers, type SearchablePickerItem } from './PickerItemRow';

/** Texts of the list's loading, empty and no-match states. */
interface PickerListTexts {
  loadingText?: string;
  emptyText?: string;
  noMatchText: string;
}

interface PickerListProps {
  listRef: RefObject<HTMLDivElement | null>;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  items: SearchablePickerItem[];
  filtered: SearchablePickerItem[];
  search: string;
  mobile: boolean;
  loading?: boolean;
  texts: PickerListTexts;
  highlightIndex: number;
  handlers: PickerRowHandlers;
}

/**
 * Nothing matches the search. On mobile, rows kept visible while searching
 * (such as "create branch") do not count as matches.
 */
function hasNoMatch(filtered: SearchablePickerItem[], search: string, mobile: boolean): boolean {
  if (filtered.length === 0) return true;
  return mobile && !!search && filtered.every((item) => item.alwaysVisibleOnMobile);
}

interface PickerListStatusProps {
  items: SearchablePickerItem[];
  filtered: SearchablePickerItem[];
  search: string;
  mobile: boolean;
  loading?: boolean;
  texts: PickerListTexts;
}

type PickerListState = 'loading' | 'empty' | 'no-match' | 'results';

function pickerListState({
  items,
  filtered,
  search,
  mobile,
  loading,
}: Omit<PickerListStatusProps, 'texts'>): PickerListState {
  if (items.length === 0) return loading ? 'loading' : 'empty';
  if (!loading && hasNoMatch(filtered, search, mobile)) return 'no-match';
  return 'results';
}

/** Loading, empty or no-match placeholder above the rows. */
function PickerListStatus({ texts, ...rest }: PickerListStatusProps) {
  const state = pickerListState(rest);
  if (state === 'loading') {
    return texts.loadingText ? (
      <LoadingState padding="sm" fill={false} label={texts.loadingText} />
    ) : null;
  }
  if (state === 'empty') {
    return texts.emptyText ? (
      <EmptyState padding="sm" fill={false} title={texts.emptyText} />
    ) : null;
  }
  if (state === 'no-match') {
    return <EmptyState padding="sm" fill={false} title={texts.noMatchText} />;
  }
  return null;
}

/** Scrollable, virtualized result list of the searchable picker. */
export function PickerList({
  listRef,
  rowVirtualizer,
  items,
  filtered,
  search,
  mobile,
  loading,
  texts,
  highlightIndex,
  handlers,
}: PickerListProps) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
      ref={listRef}
      style={{ maxHeight: mobile ? '60dvh' : 'min(60vh, 440px)' }}
    >
      <PickerListStatus
        items={items}
        filtered={filtered}
        search={search}
        mobile={mobile}
        loading={loading}
        texts={texts}
      />
      {filtered.length > 0 && (
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const item = filtered[virtualRow.index];
            return (
              <PickerItemRow
                key={item.key}
                item={item}
                i={virtualRow.index}
                size={virtualRow.size}
                start={virtualRow.start}
                highlighted={virtualRow.index === highlightIndex}
                mobile={mobile}
                search={search}
                handlers={handlers}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
