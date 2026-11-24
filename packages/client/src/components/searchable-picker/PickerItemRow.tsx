import { Check, Copy } from 'lucide-react';

import { HighlightText } from '@/components/ui/highlight-text';
import { cn } from '@/lib/utils';

export interface SearchablePickerItem {
  key: string;
  label: string;
  isSelected: boolean;
  detail?: string;
  badge?: string;
  icon?: React.ReactNode;
  /** Keep actions such as branch creation available while searching on mobile. */
  alwaysVisibleOnMobile?: boolean;
}

/** What a picker row does when it is clicked, navigated or copied. */
export interface PickerRowHandlers {
  onSelect: (key: string) => void;
  onKeyDown: (e: React.KeyboardEvent, i: number) => void;
  onHighlight: (i: number) => void;
  onCopy?: (key: string) => void;
}

interface PickerItemRowProps {
  item: SearchablePickerItem;
  /** Index of the row in the filtered list. */
  i: number;
  size: number;
  start: number;
  highlighted: boolean;
  mobile: boolean;
  search: string;
  handlers: PickerRowHandlers;
}

/** Right padding that leaves room for the copy button when there is one. */
function rowPaddingClass(hasCopy: boolean, mobile: boolean): string {
  if (!hasCopy) return 'pr-2';
  return mobile ? 'pr-14' : 'pr-7';
}

function rowToneClass(highlighted: boolean, selected: boolean): string {
  if (highlighted) return 'bg-accent text-foreground';
  if (selected) return 'bg-accent/50 text-foreground';
  return 'text-muted-foreground hover:bg-accent hover:text-foreground';
}

function PickerItemLabel({ item, search }: { item: SearchablePickerItem; search: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5">
        {item.icon && <span className="shrink-0">{item.icon}</span>}
        <HighlightText
          text={item.label}
          query={search}
          className="truncate font-mono font-medium"
        />
        {item.badge && (
          <span className="bg-muted text-muted-foreground text-3xs rounded px-1 py-0.5 leading-none">
            {item.badge}
          </span>
        )}
      </div>
      {item.detail && (
        <span className="text-muted-foreground/70 block truncate font-mono text-xs">
          {item.detail}
        </span>
      )}
    </div>
  );
}

interface CopyItemButtonProps {
  label: string;
  mobile: boolean;
  onCopy: (key: string) => void;
}

function CopyItemButton({ label, mobile, onCopy }: CopyItemButtonProps) {
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      className={cn(
        'text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 opacity-0 transition-opacity group-hover/item:opacity-100',
        mobile && 'right-0 flex size-[48px] items-center justify-center opacity-100',
      )}
      onClick={(e) => {
        e.stopPropagation();
        onCopy(label);
      }}
      tabIndex={mobile ? 0 : -1}
    >
      <Copy className="icon-xs" />
    </button>
  );
}

/** One virtualized row of the searchable picker. */
export function PickerItemRow({
  item,
  i,
  size,
  start,
  highlighted,
  mobile,
  search,
  handlers: { onSelect, onKeyDown, onHighlight, onCopy },
}: PickerItemRowProps) {
  return (
    <div
      className="group/item absolute top-0 left-0 w-full"
      style={{
        height: `${size}px`,
        transform: `translateY(${start}px)`,
      }}
    >
      <button
        type="button"
        aria-pressed={mobile ? item.isSelected : undefined}
        onClick={() => onSelect(item.key)}
        onKeyDown={(e) => onKeyDown(e, i)}
        onFocus={() => onHighlight(i)}
        onMouseEnter={() => {
          onHighlight(i);
        }}
        className={cn(
          'w-full h-full flex items-center gap-2 rounded py-1.5 pl-2 text-left text-xs transition-colors outline-hidden',
          rowPaddingClass(!!onCopy, mobile),
          mobile && 'text-base',
          rowToneClass(highlighted, item.isSelected),
        )}
      >
        <PickerItemLabel item={item} search={search} />
        {item.isSelected && <Check className="icon-xs text-status-info shrink-0" />}
      </button>
      {onCopy && <CopyItemButton label={item.label} mobile={mobile} onCopy={onCopy} />}
    </div>
  );
}
