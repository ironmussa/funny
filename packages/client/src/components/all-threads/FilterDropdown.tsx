import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface Props {
  label: string;
  /** `detail` is a second, muted line under the option's label; `icon` sits before the label. */
  options: FilterOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  counts?: Record<string, number>;
  testId?: string;
  /** Puts a field at the top of the menu that narrows the options by label and detail. */
  search?: { placeholder: string };
}

interface FilterOption {
  value: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
}

function resolveTriggerLabel(
  label: string,
  options: FilterOption[],
  selected: Set<string>,
): string {
  if (selected.size === 0) return label;
  if (selected.size === 1) return options.find((o) => selected.has(o.value))?.label ?? label;
  return `${label} (${selected.size})`;
}

function moveMenuFocus(container: HTMLDivElement | null, e: React.KeyboardEvent): void {
  if (!container) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]'));
  const idx = items.findIndex((item) => item === document.activeElement);
  const targets = new Map<string, HTMLElement | undefined>([
    ['ArrowDown', items[(idx + 1) % items.length]],
    ['ArrowUp', items[(idx - 1 + items.length) % items.length]],
    ['Home', items[0]],
    ['End', items[items.length - 1]],
  ]);
  const next = targets.get(e.key);
  if (!next) return;
  e.preventDefault();
  next.focus();
}

function FilterOptionRow({
  opt,
  isActive,
  count,
  testId,
  onToggle,
}: {
  opt: FilterOption;
  isActive: boolean;
  count: number | undefined;
  testId?: string;
  onToggle: (value: string) => void;
}) {
  return (
    <button
      role="menuitemcheckbox"
      data-testid={testId ? `${testId}-option-${opt.value}` : undefined}
      aria-checked={isActive}
      tabIndex={-1}
      onClick={() => onToggle(opt.value)}
      className={cn(
        'flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm transition-colors text-left',
        'hover:bg-accent hover:text-accent-foreground',
        'focus:bg-accent focus:text-accent-foreground focus:outline-hidden',
        isActive && 'text-accent-foreground',
      )}
    >
      <span
        className={cn(
          'flex h-3.5 w-3.5 items-center justify-center rounded-sm border',
          isActive
            ? 'bg-primary border-primary text-primary-foreground'
            : 'border-muted-foreground/30',
        )}
      >
        {isActive && <Check className="icon-2xs" />}
      </span>
      {opt.icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{opt.label}</span>
        {opt.detail && (
          <span className="text-muted-foreground text-2xs truncate font-mono">{opt.detail}</span>
        )}
      </span>
      {count != null && count > 0 && (
        <span className="text-muted-foreground tabular-nums">{count}</span>
      )}
    </button>
  );
}

/**
 * Multi-select chip + popover used for status / sync-state filtering in
 * AllThreadsView. Extracted so the parent doesn't import Popover + the
 * ChevronDown / Check icons just for this component.
 */
export function FilterDropdown({
  label,
  options,
  selected,
  onToggle,
  counts,
  testId,
  search,
}: Props) {
  const activeCount = selected.size;
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shownOptions =
    search && needle
      ? options.filter((o) => `${o.label} ${o.detail ?? ''}`.toLowerCase().includes(needle))
      : options;
  const triggerLabel = resolveTriggerLabel(label, options, selected);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    moveMenuFocus(listRef.current, e);
  }, []);

  return (
    <Popover onOpenChange={(open) => !open && setQuery('')}>
      <PopoverTrigger asChild>
        <button
          data-testid={testId}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap',
            activeCount > 0
              ? 'bg-accent text-accent-foreground border-accent-foreground/20'
              : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground',
          )}
        >
          {triggerLabel}
          <ChevronDown className="icon-xs opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        padding="xs"
        className="w-auto min-w-[160px]"
        onKeyDown={handleKeyDown}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          // With a search field, typing is the first thing to do.
          if (search) return;
          listRef.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus();
        }}
      >
        {search && (
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown') return;
              e.preventDefault();
              listRef.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus();
            }}
            placeholder={search.placeholder}
            aria-label={search.placeholder}
            className="mb-1 h-7"
            data-testid={testId ? `${testId}-search` : undefined}
          />
        )}
        <div ref={listRef} role="menu" className={cn(search && 'max-h-72 overflow-y-auto')}>
          {shownOptions.map((opt) => (
            <FilterOptionRow
              key={opt.value}
              opt={opt}
              isActive={selected.has(opt.value)}
              count={counts?.[opt.value]}
              testId={testId}
              onToggle={onToggle}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
