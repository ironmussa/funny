import type { PRReactionContent, PRReactionSummary } from '@funny/shared';
import { Smile } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { REACTION_EMOJI, REACTION_ORDER, reactionCounts } from './pr-card-helpers';

/** Reaction counts of a comment plus a picker to add one. */
export function ReactionBar({
  reactions,
  onReact,
  disabled,
  testIdBase,
}: {
  reactions: PRReactionSummary | undefined;
  onReact: (c: PRReactionContent) => void;
  disabled?: boolean;
  testIdBase: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const counts = reactionCounts(reactions);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {counts.map(({ key, count }) => (
        <Button
          key={key}
          variant="outline"
          size="xs"
          className="text-2xs h-5 gap-1 px-1.5"
          disabled={disabled}
          onClick={() => onReact(key)}
          data-testid={`${testIdBase}-reaction-${key}`}
        >
          <span>{REACTION_EMOJI[key]}</span>
          <span>{count}</span>
        </Button>
      ))}
      <div className="relative">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="muted"
              size="icon-xs"
              disabled={disabled}
              onClick={() => setPickerOpen((v) => !v)}
              data-testid={`${testIdBase}-react-open`}
            >
              <Smile className="icon-xs" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Add reaction</TooltipContent>
        </Tooltip>
        {pickerOpen && (
          <div
            className="border-border bg-popover absolute top-full left-0 z-10 mt-1 flex gap-0.5 rounded-md border p-1 shadow-md"
            data-testid={`${testIdBase}-react-picker`}
          >
            {REACTION_ORDER.map((k) => (
              <button
                key={k}
                className="hover:bg-accent rounded px-1 text-sm"
                onClick={() => {
                  onReact(k);
                  setPickerOpen(false);
                }}
                data-testid={`${testIdBase}-react-${k}`}
              >
                {REACTION_EMOJI[k]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
