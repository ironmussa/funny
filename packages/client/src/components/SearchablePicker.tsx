import { useVirtualizer } from '@tanstack/react-virtual';
import { GitBranch, Check, Copy, Plus } from 'lucide-react';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { HighlightText } from '@/components/ui/highlight-text';
import { Input } from '@/components/ui/input';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface SearchablePickerItem {
  key: string;
  label: string;
  isSelected: boolean;
  detail?: string;
  badge?: string;
  icon?: React.ReactNode;
}

const ITEM_HEIGHT = 32;

export function SearchablePicker({
  items,
  label,
  displayValue,
  searchPlaceholder,
  noMatchText,
  emptyText,
  loadingText,
  loading,
  onSelect,
  onCopy,
  triggerClassName,
  triggerTitle,
  width = 'w-[28rem]',
  side = 'top',
  align = 'start',
  icon,
  testId,
}: {
  items: SearchablePickerItem[];
  label: string;
  displayValue: string;
  searchPlaceholder: string;
  noMatchText: string;
  emptyText?: string;
  loadingText?: string;
  loading?: boolean;
  onSelect: (key: string) => void;
  onCopy?: (key: string) => void;
  triggerClassName?: string;
  triggerTitle?: string;
  width?: string;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  icon?: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!search) return items;
    const q = search.toLowerCase();
    return items
      .filter((item) => item.label.toLowerCase().includes(q))
      .sort((a, b) => {
        const aLower = a.label.toLowerCase();
        const bLower = b.label.toLowerCase();
        const aStartsWith = aLower.startsWith(q) ? 0 : 1;
        const bStartsWith = bLower.startsWith(q) ? 0 : 1;
        if (aStartsWith !== bStartsWith) return aStartsWith - bStartsWith;
        return aLower.length - bLower.length || aLower.localeCompare(bLower);
      });
  }, [items, search]);

  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 10,
  });

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightIndex(-1);
  }, [search]);

  // Re-measure virtualizer and scroll selected item into view when popover opens
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        rowVirtualizer.measure();
        if (!search) {
          const selectedIndex = filtered.findIndex((item) => item.isSelected);
          if (selectedIndex >= 0) {
            rowVirtualizer.scrollToIndex(selectedIndex, { align: 'center' });
          }
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-measure on open
  }, [open]);

  const scrollToIndex = useCallback(
    (index: number) => {
      // Schedule scroll after React has re-rendered so the virtualizer
      // has the updated highlightIndex and can render the target row.
      requestAnimationFrame(() => {
        rowVirtualizer.scrollToIndex(index, { align: 'auto' });
      });
    },
    [rowVirtualizer],
  );

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filtered.length > 0) {
        const next = highlightIndex < filtered.length - 1 ? highlightIndex + 1 : 0;
        setHighlightIndex(next);
        scrollToIndex(next);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filtered.length > 0) {
        const prev = highlightIndex > 0 ? highlightIndex - 1 : filtered.length - 1;
        setHighlightIndex(prev);
        scrollToIndex(prev);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < filtered.length) {
        onSelect(filtered[highlightIndex].key);
        setOpen(false);
        setSearch('');
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setSearch('');
    }
  };

  const handleItemKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = i < filtered.length - 1 ? i + 1 : 0;
      setHighlightIndex(next);
      scrollToIndex(next);
      // Keep focus on the search input so keyboard navigation stays consistent
      searchInputRef.current?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = i > 0 ? i - 1 : filtered.length - 1;
      setHighlightIndex(prev);
      scrollToIndex(prev);
      searchInputRef.current?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSelect(filtered[i].key);
      setOpen(false);
      setSearch('');
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setSearch('');
          setHighlightIndex(-1);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          data-testid={testId}
          className={
            triggerClassName ??
            'flex max-w-[300px] items-center gap-1 truncate rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none'
          }
          title={triggerTitle}
          tabIndex={-1}
        >
          {icon ?? <GitBranch className="icon-xs shrink-0" />}
          <span className="truncate font-mono">{displayValue}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className={cn(width, 'p-0 flex flex-col overflow-hidden')}
        style={{ maxHeight: 'min(70vh, 520px)' }}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchInputRef.current?.focus();
        }}
      >
        <div className="border-b border-border bg-muted/30 px-3 py-2">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          ref={listRef}
          style={{ maxHeight: 'min(60vh, 440px)' }}
        >
          {loading && items.length === 0 && loadingText && (
            <p className="py-3 text-center text-sm text-muted-foreground">{loadingText}</p>
          )}
          {!loading && items.length === 0 && emptyText && (
            <p className="py-3 text-center text-sm text-muted-foreground">{emptyText}</p>
          )}
          {!loading && items.length > 0 && filtered.length === 0 && (
            <p className="py-3 text-center text-sm text-muted-foreground">{noMatchText}</p>
          )}
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
                const i = virtualRow.index;
                return (
                  <div
                    key={item.key}
                    className="group/item absolute left-0 top-0 w-full"
                    style={{
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <button
                      onClick={() => {
                        onSelect(item.key);
                        setOpen(false);
                        setSearch('');
                      }}
                      onKeyDown={(e) => handleItemKeyDown(e, i)}
                      onFocus={() => setHighlightIndex(i)}
                      onMouseEnter={() => {
                        setHighlightIndex(i);
                      }}
                      className={cn(
                        'w-full h-full flex items-center gap-2 rounded py-1.5 pl-2 text-left text-xs transition-colors outline-none',
                        onCopy ? 'pr-7' : 'pr-2',
                        i === highlightIndex
                          ? 'bg-accent text-foreground'
                          : item.isSelected
                            ? 'bg-accent/50 text-foreground'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {item.icon && <span className="shrink-0">{item.icon}</span>}
                          <HighlightText
                            text={item.label}
                            query={search}
                            className="truncate font-mono font-medium"
                          />
                          {item.badge && (
                            <span className="rounded bg-muted px-1 py-0.5 text-[9px] leading-none text-muted-foreground">
                              {item.badge}
                            </span>
                          )}
                        </div>
                        {item.detail && (
                          <span className="block truncate font-mono text-xs text-muted-foreground/70">
                            {item.detail}
                          </span>
                        )}
                      </div>
                      {item.isSelected && <Check className="icon-xs shrink-0 text-status-info" />}
                    </button>
                    {onCopy && (
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/item:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCopy(item.label);
                        }}
                        tabIndex={-1}
                      >
                        <Copy className="icon-xs" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="border-t border-border px-2 py-1.5">
          <Input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={searchPlaceholder}
            aria-label={label}
            autoComplete="off"
            className="h-auto w-full rounded-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

const CREATE_NEW_BRANCH_KEY = '__create_new_branch__';
const EMPTY_REMOTE_BRANCHES: string[] = [];

export function BranchPicker({
  branches,
  remoteBranches = EMPTY_REMOTE_BRANCHES,
  defaultBranch,
  selected,
  onChange,
  triggerClassName,
  width = 'w-[30rem]',
  side = 'top',
  align = 'start',
  extraItems,
  showCopy = true,
  placeholder,
  showCreateNew = false,
  testId,
}: {
  branches: string[];
  remoteBranches?: string[];
  defaultBranch?: string | null;
  selected: string;
  onChange: (branch: string) => void;
  triggerClassName?: string;
  width?: string;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  extraItems?: SearchablePickerItem[];
  showCopy?: boolean;
  placeholder?: string;
  showCreateNew?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [creatingNew, setCreatingNew] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const newBranchInputRef = useRef<HTMLInputElement>(null);

  const remoteSet = useMemo(() => new Set(remoteBranches), [remoteBranches]);

  const items: SearchablePickerItem[] = useMemo(() => {
    const branchItems = branches
      .map((b) => {
        const badges: string[] = [];
        if (b === defaultBranch) badges.push('default');
        if (remoteSet.has(b)) badges.push('origin');
        return {
          key: b,
          label: b,
          isSelected: b === selected,
          badge: badges.length > 0 ? badges.join(' · ') : undefined,
        };
      })
      .sort((a, b) => {
        // Default branch always first
        if (a.key === defaultBranch) return -1;
        if (b.key === defaultBranch) return 1;
        return 0;
      });
    if (extraItems) {
      return [...extraItems, ...branchItems];
    }
    return branchItems;
  }, [branches, selected, extraItems, defaultBranch, remoteSet]);

  const handleSelect = useCallback(
    (key: string) => {
      if (key === CREATE_NEW_BRANCH_KEY) {
        setCreatingNew(true);
        setNewBranchName('');
        return;
      }
      setCreatingNew(false);
      onChange(key);
    },
    [onChange],
  );

  const handleConfirmNewBranch = useCallback(() => {
    const trimmed = newBranchName.trim();
    if (!trimmed) return;
    // Sanitize: replace spaces with dashes, remove invalid git branch chars
    const sanitized = trimmed
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9/_.-]/g, '')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.-]|[.-]$/g, '');
    if (!sanitized) return;
    setCreatingNew(false);
    setNewBranchName('');
    onChange(sanitized);
  }, [newBranchName, onChange]);

  // Focus the new branch input when entering create mode
  useEffect(() => {
    if (creatingNew) {
      requestAnimationFrame(() => newBranchInputRef.current?.focus());
    }
  }, [creatingNew]);

  const createNewItem: SearchablePickerItem | undefined = showCreateNew
    ? {
        key: CREATE_NEW_BRANCH_KEY,
        label: t('newThread.createNewBranch', 'Create new branch'),
        isSelected: false,
        icon: <Plus className="icon-xs text-muted-foreground" />,
      }
    : undefined;

  const allItems = useMemo(() => {
    if (!createNewItem) return items;
    return [createNewItem, ...items];
  }, [createNewItem, items]);

  if (creatingNew) {
    return (
      <div className="flex items-center gap-1" data-testid={testId ? `${testId}-new` : undefined}>
        <Plus className="icon-xs shrink-0 text-muted-foreground" />
        <Input
          ref={newBranchInputRef}
          type="text"
          value={newBranchName}
          onChange={(e) => setNewBranchName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleConfirmNewBranch();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setCreatingNew(false);
              setNewBranchName('');
            }
          }}
          onBlur={() => {
            // If the user blurs without entering a name, go back
            if (!newBranchName.trim()) {
              setCreatingNew(false);
              setNewBranchName('');
            }
          }}
          placeholder={t('newThread.newBranchPlaceholder', 'new-branch-name')}
          data-testid={testId ? `${testId}-new-input` : undefined}
          className="h-auto w-40 rounded-none border-0 bg-transparent p-0 font-mono text-xs text-foreground shadow-none focus-visible:ring-0"
        />
        <button
          type="button"
          onClick={handleConfirmNewBranch}
          disabled={!newBranchName.trim()}
          data-testid={testId ? `${testId}-new-confirm` : undefined}
          className="rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Check className="icon-xs" />
        </button>
      </div>
    );
  }

  return (
    <SearchablePicker
      items={allItems}
      label={t('newThread.baseBranch', 'Base branch')}
      displayValue={selected || placeholder || t('newThread.selectBranch')}
      searchPlaceholder={t('newThread.searchBranches', 'Search branches\u2026')}
      noMatchText={t('newThread.noBranchesMatch', 'No branches match')}
      onSelect={handleSelect}
      onCopy={
        showCopy
          ? (label) => {
              if (label === t('newThread.createNewBranch', 'Create new branch')) return;
              navigator.clipboard.writeText(label);
              toast.success('Branch copied');
            }
          : undefined
      }
      triggerClassName={triggerClassName}
      width={width}
      side={side}
      align={align}
      testId={testId}
    />
  );
}
