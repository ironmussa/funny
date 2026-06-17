import { Grid2x2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

import { MAX_GRID_COLS, MAX_GRID_ROWS } from './grid-constants';

interface Props {
  cols: number;
  rows: number;
  onChange: (cols: number, rows: number) => void;
}

/**
 * Compact "2×2" badge in the grid header that opens a hover-grid picker for
 * choosing the number of grid columns/rows. Extracted so LiveColumnsView
 * doesn't need the Popover or Grid2x2 icon.
 */
export function GridPicker({ cols, rows, onChange }: Props) {
  const [hoverCol, setHoverCol] = useState(0);
  const [hoverRow, setHoverRow] = useState(0);
  const [open, setOpen] = useState(false);

  const displayCol = open && hoverCol > 0 ? hoverCol : cols;
  const displayRow = open && hoverRow > 0 ? hoverRow : rows;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="h-6 min-w-0 gap-1.5 px-2 text-[10px]">
          <Grid2x2 className="icon-sm" />
          {cols}×{rows}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start" sideOffset={4}>
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${MAX_GRID_COLS}, 1fr)` }}
          onMouseLeave={() => {
            setHoverCol(0);
            setHoverRow(0);
          }}
        >
          {Array.from({ length: MAX_GRID_ROWS }, (_, r) =>
            Array.from({ length: MAX_GRID_COLS }, (_, c) => {
              const isHighlighted = c + 1 <= displayCol && r + 1 <= displayRow;
              return (
                <button
                  key={`${c}-${r}`}
                  className={cn(
                    'w-5 h-5 rounded-sm border transition-colors',
                    isHighlighted
                      ? 'bg-primary border-primary'
                      : 'bg-muted/40 border-border hover:border-muted-foreground/40',
                  )}
                  onMouseEnter={() => {
                    setHoverCol(c + 1);
                    setHoverRow(r + 1);
                  }}
                  onClick={() => {
                    onChange(c + 1, r + 1);
                    setOpen(false);
                  }}
                />
              );
            }),
          )}
        </div>
        <p className="text-muted-foreground mt-2 text-center text-[10px]">
          {displayCol}×{displayRow}
        </p>
      </PopoverContent>
    </Popover>
  );
}
