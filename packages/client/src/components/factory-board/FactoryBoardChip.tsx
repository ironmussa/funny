/**
 * One chip of a factory board card: a short word, and the full explanation on
 * hover. Every note a card has (its state, a gate, why it waits) is one of
 * these, so the card has no lines of text under its chips.
 */
import { LabelBadge, type LabelBadgeTone } from '@/components/ui/label-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface Props {
  label: string;
  tone: LabelBadgeTone;
  /** Shown on hover; several lines allowed. */
  detail?: string;
  /** The result is for an older commit: the chip is faded. */
  faded?: boolean;
  testId: string;
  /** `data-*` attributes for the badge (state, tone, stale). */
  data?: Record<`data-${string}`, string | undefined>;
}

export function FactoryBoardChip({ label, tone, detail, faded, testId, data }: Props) {
  // Every wrapper is inline-flex: an inline span sits the chip on a text
  // baseline, a few pixels below the other chips of the flex row.
  const badge = (
    <span className={cn('inline-flex', faded && 'opacity-60')}>
      <LabelBadge tone={tone} data-testid={testId} {...data}>
        {label}
      </LabelBadge>
    </span>
  );
  if (!detail) return <span className="inline-flex">{badge}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-sm">
        <div className="whitespace-pre-line">{detail}</div>
      </TooltipContent>
    </Tooltip>
  );
}
