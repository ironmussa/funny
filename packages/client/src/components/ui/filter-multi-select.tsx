import { Check, ChevronDown } from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface MultiSelectOption {
  /** The value sent to the API (label name or user login). */
  value: string;
  /** The display label. */
  label: string;
  /** Optional color dot (labels) — a hex string without the leading `#`. */
  color?: string;
  /** Optional avatar (users). */
  avatarUrl?: string;
}

interface MultiSelectProps {
  icon: React.ReactNode;
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
  testId: string;
  onOpenChange?: (open: boolean) => void;
  footer?: React.ReactNode;
}

/** A searchable multi-select chip: click toggles membership without closing. */
export function FilterMultiSelect({
  icon,
  label,
  options,
  selected,
  onChange,
  searchPlaceholder,
  emptyText,
  disabled,
  testId,
  onOpenChange,
  footer,
}: MultiSelectProps) {
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };
  const active = selected.length > 0;

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid={testId}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs whitespace-nowrap transition-colors disabled:opacity-50',
            active
              ? 'bg-accent text-accent-foreground border-accent-foreground/20'
              : 'border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground bg-transparent',
          )}
        >
          {icon}
          <span>{label}</span>
          {active && (
            <span className="bg-primary text-primary-foreground ml-0.5 rounded-full px-1 text-[9px] leading-4 font-semibold">
              {selected.length}
            </span>
          )}
          <ChevronDown className="icon-xs opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-0">
        <Command
          filter={(value, search) => (value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
        >
          <CommandInput
            placeholder={searchPlaceholder}
            className="h-9 text-xs"
            data-testid={`${testId}-search`}
          />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {(() => {
                const selectedValues = new Set(selected);
                return options.map((opt) => {
                  const isActive = selectedValues.has(opt.value);
                  return (
                    <CommandItem
                      key={opt.value}
                      value={opt.label}
                      onSelect={() => toggle(opt.value)}
                      className="text-xs"
                      data-testid={`${testId}-option-${opt.value}`}
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
                      {opt.color !== undefined && (
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: `#${opt.color}` }}
                        />
                      )}
                      {opt.avatarUrl && (
                        <img
                          src={opt.avatarUrl}
                          alt=""
                          className="size-3.5 shrink-0 rounded-full"
                        />
                      )}
                      <span className="flex-1 truncate">{opt.label}</span>
                    </CommandItem>
                  );
                });
              })()}
            </CommandGroup>
          </CommandList>
        </Command>
        {footer}
      </PopoverContent>
    </Popover>
  );
}
