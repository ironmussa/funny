import type { LucideIcon } from 'lucide-react';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export interface ThreadGroupProps {
  /** Section title shown next to the icon */
  title: string;
  /** Optional count shown in parentheses after the title */
  count?: number;
  /** Icon rendered between the chevron and the title */
  icon?: LucideIcon;
  /** Alternative: render a custom element instead of an icon (e.g. a pulsing dot) */
  iconElement?: ReactNode;
  /** Whether the section starts expanded (default: true) */
  defaultExpanded?: boolean;
  /** Controlled open state */
  open?: boolean;
  /** Controlled open change handler */
  onOpenChange?: (open: boolean) => void;
  /** The thread items and optional ViewAll button */
  children: ReactNode;
  /** data-testid for the collapsible trigger */
  'data-testid'?: string;
}

export function ThreadGroup({
  title,
  count,
  icon: Icon,
  iconElement,
  defaultExpanded = true,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  children,
  ...props
}: ThreadGroupProps) {
  const [internalOpen, setInternalOpen] = useState(defaultExpanded);
  const isControlled = controlledOpen !== undefined;
  const isExpanded = isControlled ? controlledOpen : internalOpen;
  const handleOpenChange = isControlled ? controlledOnOpenChange : setInternalOpen;

  return (
    <Collapsible open={isExpanded} onOpenChange={handleOpenChange} className="mb-1 min-w-0">
      <CollapsibleTrigger
        data-testid={props['data-testid']}
        className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            'icon-xs flex-shrink-0 transition-transform duration-200',
            isExpanded && 'rotate-90',
          )}
        />
        {iconElement ?? (Icon && <Icon className="icon-sm flex-shrink-0" />)}
        <span className="truncate font-medium">
          {title}
          {count !== undefined && ` (${count})`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-slide-down">
        <div className="mt-0.5 min-w-0 space-y-0.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
