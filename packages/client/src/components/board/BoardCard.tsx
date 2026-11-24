/**
 * The card both boards draw (the thread kanban and the factory board): a
 * status glyph beside a title of up to three lines that spans the card, a body
 * for what the board adds (a run's chips and notes), and a footer line with
 * the secondary facts (project, pull request, diff) and, at its end, the time
 * that turns into the card's actions on hover. The whole card opens its item;
 * interactive children stop their own clicks.
 */
import type { KeyboardEvent, ReactNode, Ref } from 'react';

import { cn } from '@/lib/utils';

/** The title's look on a board card: muted until the card is hovered. */
export const BOARD_CARD_TITLE_CLASS =
  'text-muted-foreground group-hover/card:text-foreground line-clamp-3 text-sm leading-relaxed font-medium transition-colors';

interface Props {
  ref?: Ref<HTMLDivElement>;
  testId: string;
  /** Opens the card's item (click, or Enter on the card). */
  onOpen: () => void;
  /** The status glyph left of the title. */
  status: ReactNode;
  title: ReactNode;
  /** What the board adds between the title and the footer. */
  children?: ReactNode;
  /** The secondary facts on the footer line, left of the time. */
  footer?: ReactNode;
  /** The time at the end of the footer line. */
  time: ReactNode;
  /** What replaces the time on hover (a menu); keep it shown with `actionsOpen`. */
  actions?: ReactNode;
  actionsOpen?: boolean;
  className?: string;
  /** False on a board whose cards only the server moves. */
  draggable?: boolean;
}

export function BoardCard({
  ref,
  testId,
  onOpen,
  status,
  title,
  children,
  footer,
  time,
  actions,
  actionsOpen = false,
  className,
  draggable,
}: Props) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.key === 'Enter') onOpen();
  };
  return (
    <div
      ref={ref}
      data-testid={testId}
      role="link"
      tabIndex={0}
      draggable={draggable}
      className={cn(
        'group/card bg-card flex cursor-pointer flex-col gap-2 rounded-md border px-3.5 py-3 transition-[opacity,box-shadow] duration-300',
        className,
      )}
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      <div className="flex min-w-0 items-start gap-2">
        {/* `status-glyph-dots`: like a sidebar thread row, a dot theme (Minimal) shows dots here. */}
        <span className="status-glyph-dots mt-0.5 flex shrink-0">{status}</span>
        <div className="min-w-0 flex-1">{title}</div>
      </div>
      {children}

      <div className="flex min-w-0 items-center gap-2" data-testid={`${testId}-footer`}>
        <div className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 text-xs">
          {footer}
        </div>
        {/* `-my-1`: the hover menu's button is taller than the line and must not grow it. */}
        <div className="-my-1 grid shrink-0 place-items-center justify-items-end">
          <span
            className={cn(
              'text-muted-foreground col-start-1 row-start-1 h-4 text-xs leading-4',
              actions && 'group-hover/card:pointer-events-none group-hover/card:opacity-0',
              actionsOpen && 'pointer-events-none opacity-0',
            )}
          >
            {time}
          </span>
          {actions && (
            <div
              className={cn(
                'col-start-1 row-start-1 flex items-center opacity-0 group-hover/card:opacity-100',
                actionsOpen && 'opacity-100!',
              )}
            >
              {actions}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
