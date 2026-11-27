import type { InboxItem } from '@funny/shared';
import { Inbox } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useMinuteTick } from '@/hooks/use-minute-tick';

import { InboxRunRow } from './InboxRunRow';
import type { InboxSelection } from './use-inbox-selection';

/**
 * The filtered inbox runs with a checkbox each; the select-all checkbox and
 * the bulk actions live in the toolbar above (`InboxSelectionControls`).
 */
export function InboxRunList({
  items,
  search,
  hasFilters,
  selection,
  activeThreadId,
  onOpen,
}: {
  items: InboxItem[];
  search: string;
  hasFilters: boolean;
  selection: InboxSelection;
  /** The thread open beside the inbox, whose run is highlighted. */
  activeThreadId?: string | null;
  onOpen: (thread: InboxItem['thread']) => void;
}) {
  const now = useMinuteTick();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {items.length === 0 ? (
        <InboxEmpty search={search} hasFilters={hasFilters} />
      ) : (
        <div data-testid="inbox-list-scroll" className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-1">
            {items.map((item) => (
              <InboxRunRow
                key={item.run.id}
                item={item}
                checked={selection.checked.has(item.run.id)}
                active={!!activeThreadId && item.thread.id === activeThreadId}
                search={search}
                now={now}
                onCheck={selection.toggle}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** No run listed: none matches the search or filters, or the inbox is empty. */
function InboxEmpty({ search, hasFilters }: { search: string; hasFilters: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="inbox-empty"
      className="text-muted-foreground flex flex-1 flex-col items-center justify-center"
    >
      <Inbox className="mb-3 size-8 opacity-50" />
      <p className="text-sm">
        {search || hasFilters ? t('automationInbox.noMatch') : t('automationInbox.empty')}
      </p>
      {!search && !hasFilters && <p className="mt-1 text-xs">{t('automationInbox.emptyHint')}</p>}
    </div>
  );
}
