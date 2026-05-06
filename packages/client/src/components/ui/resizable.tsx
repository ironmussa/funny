import { GripVertical } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { GroupProps, PanelProps, SeparatorProps } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

const ResizablePanelGroup = ({ className, ...props }: GroupProps) => (
  <Group
    className={cn(
      'flex h-full w-full [&>[data-panel]]:min-h-0 [&>[data-panel]]:min-w-0',
      className,
    )}
    {...props}
  />
);

const ResizablePanel = Panel;

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: SeparatorProps & { withHandle?: boolean }) => (
  <Separator
    className={cn(
      'relative flex shrink-0 items-center justify-center bg-border transition-colors',
      'aria-[orientation=vertical]:h-full aria-[orientation=vertical]:w-[3px] aria-[orientation=vertical]:cursor-col-resize',
      'aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:h-[3px] aria-[orientation=horizontal]:cursor-row-resize',
      'hover:bg-ring/50 data-[separator=active]:bg-ring/50 data-[separator=hover]:bg-ring/50',
      'after:absolute',
      'aria-[orientation=vertical]:after:inset-y-0 aria-[orientation=vertical]:after:left-1/2 aria-[orientation=vertical]:after:w-3 aria-[orientation=vertical]:after:-translate-x-1/2',
      'aria-[orientation=horizontal]:after:inset-x-0 aria-[orientation=horizontal]:after:top-1/2 aria-[orientation=horizontal]:after:h-3 aria-[orientation=horizontal]:after:-translate-y-1/2',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50',
      className,
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
        <GripVertical className="h-2.5 w-2.5 aria-[orientation=horizontal]:rotate-90" />
      </div>
    )}
  </Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
