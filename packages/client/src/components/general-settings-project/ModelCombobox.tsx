import { Check, ChevronsUpDown } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
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

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
  searchPlaceholder: string;
}

/**
 * Searchable combobox used by GeneralSettings to pick a default model. Owns
 * the Popover open state. Extracted from the parent so the Command/Popover
 * clusters move out of GeneralSettings's import graph.
 */
export function ModelCombobox({ value, onChange, options, placeholder, searchPlaceholder }: Props) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          className="h-8 w-[160px] justify-between text-xs"
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronsUpDown className="icon-xs ml-1 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} className="h-8 text-xs" />
          <CommandList id={listId}>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.label}
                  onSelect={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className="text-xs"
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      value === opt.value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
