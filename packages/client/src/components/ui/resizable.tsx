import { GripVertical } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { GroupProps, PanelProps, SeparatorProps } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

const ResizablePanelGroup = ({ className, ...props }: GroupProps) => (
  <Group
    className={cn('flex size-full [&>[data-panel]]:min-h-0 [&>[data-panel]]:min-w-0', className)}
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
      'relative flex w-[3px] items-center justify-center bg-border transition-colors',
      'hover:bg-ring/50 data-[separator=active]:bg-ring/50 data-[separator=hover]:bg-ring/50',
      'after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50',
      className,
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
        <GripVertical className="size-2.5" />
      </div>
    )}
  </Separator>
);

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
