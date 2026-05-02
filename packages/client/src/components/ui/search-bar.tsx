import { ArrowDown, ArrowUp, CaseSensitive, Loader2, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface SearchBarProps {
  /** Current query string */
  query: string;
  /** Called when the user types */
  onQueryChange: (query: string) => void;
  /** Total number of matches (or filtered results, depending on context) */
  totalMatches: number;
  /** Current match index (0-based). Required when `onPrev`/`onNext` are provided; ignored otherwise. */
  currentIndex?: number;
  /** Go to the previous match. Omit to hide the prev button (e.g. list filters). */
  onPrev?: () => void;
  /** Go to the next match. Omit to hide the next button (e.g. list filters). */
  onNext?: () => void;
  /** Close the search bar. When omitted, the close button is hidden. */
  onClose?: () => void;
  /** Show a loading spinner */
  loading?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Show a search icon on the left */
  showIcon?: boolean;
  /** Additional class names for the container */
  className?: string;
  /** Prefix for data-testid attributes */
  testIdPrefix?: string;
  /** Auto-focus the input on mount */
  autoFocus?: boolean;
  /** Current case-sensitive state. When `onCaseSensitiveChange` is provided, a toggle is shown. */
  caseSensitive?: boolean;
  /** Called when the user toggles case sensitivity. Pass to enable the toggle button. */
  onCaseSensitiveChange?: (value: boolean) => void;
  /**
   * Override the result label (e.g. "12 / 50" for list filters).
   * If omitted, the label is computed from `currentIndex`/`totalMatches`.
   */
  resultLabel?: string;
  /** Forward additional key events from the input (e.g. ArrowUp/Down for list nav) */
  onInputKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Forward a ref to the input element */
  inputRef?: React.Ref<HTMLInputElement>;
}

export function SearchBar({
  query,
  onQueryChange,
  currentIndex,
  totalMatches,
  onPrev,
  onNext,
  onClose,
  loading = false,
  placeholder = 'Search...',
  showIcon = true,
  className,
  testIdPrefix = 'search',
  autoFocus = true,
  caseSensitive = false,
  onCaseSensitiveChange,
  resultLabel,
  onInputKeyDown,
  inputRef: externalInputRef,
}: SearchBarProps) {
  const internalInputRef = useRef<HTMLInputElement>(null);
  const [closing, setClosing] = useState(false);

  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      internalInputRef.current = node;
      if (typeof externalInputRef === 'function') externalInputRef(node);
      else if (externalInputRef && 'current' in externalInputRef) {
        (externalInputRef as React.MutableRefObject<HTMLInputElement | null>).current = node;
      }
    },
    [externalInputRef],
  );

  useEffect(() => {
    if (autoFocus) {
      requestAnimationFrame(() => internalInputRef.current?.focus());
    }
  }, [autoFocus]);

  const startClose = useCallback(() => {
    if (onClose) setClosing(true);
  }, [onClose]);

  const handleAnimationEnd = useCallback(() => {
    if (closing) onClose?.();
  }, [closing, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape' && onClose) {
        e.preventDefault();
        startClose();
        return;
      }
      if (e.key === 'Enter' && (onPrev || onNext)) {
        e.preventDefault();
        if (e.shiftKey) onPrev?.();
        else onNext?.();
        return;
      }
      if (e.altKey && (e.key === 'c' || e.key === 'C') && onCaseSensitiveChange) {
        e.preventDefault();
        onCaseSensitiveChange(!caseSensitive);
        return;
      }
      onInputKeyDown?.(e);
    },
    [startClose, onPrev, onNext, onClose, onInputKeyDown, onCaseSensitiveChange, caseSensitive],
  );

  const computedLabel = query
    ? totalMatches > 0
      ? currentIndex != null
        ? `${currentIndex + 1}/${totalMatches}`
        : `${totalMatches}`
      : `0`
    : `0`;
  const label = resultLabel ?? computedLabel;

  const showNav = !!(onPrev || onNext);

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 duration-150',
        closing
          ? 'animate-out fade-out slide-out-to-top-2 fill-mode-forwards'
          : 'animate-in fade-in slide-in-from-top-2',
        className,
      )}
      onAnimationEnd={handleAnimationEnd}
      data-testid={`${testIdPrefix}-bar`}
    >
      {showIcon && <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
      <Input
        ref={setInputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="h-7 flex-1 rounded-none border-none bg-transparent text-xs shadow-none focus-visible:ring-0"
        data-testid={`${testIdPrefix}-input`}
      />
      <span
        aria-hidden={!loading}
        className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center"
      >
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </span>
      <span
        className="min-w-[2.5rem] flex-shrink-0 text-center text-xs tabular-nums text-muted-foreground"
        data-testid={`${testIdPrefix}-count`}
      >
        {label}
      </span>
      {onCaseSensitiveChange && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onCaseSensitiveChange(!caseSensitive)}
          aria-pressed={caseSensitive}
          title={`Match case (${caseSensitive ? 'on' : 'off'}) — Alt+C`}
          className={cn(caseSensitive && 'bg-accent text-accent-foreground')}
          data-testid={`${testIdPrefix}-case-sensitive`}
        >
          <CaseSensitive className="h-3.5 w-3.5" />
        </Button>
      )}
      {showNav && (
        <>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onPrev}
            disabled={!onPrev || totalMatches === 0}
            data-testid={`${testIdPrefix}-prev`}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onNext}
            disabled={!onNext || totalMatches === 0}
            data-testid={`${testIdPrefix}-next`}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
      {onClose && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={startClose}
          data-testid={`${testIdPrefix}-close`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
