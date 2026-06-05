import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';

import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';

const meta = {
  title: 'UI/ResizeHandle',
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function HorizontalStory() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState(50);
  const startPct = useRef(leftPct);

  const { resizing, handlePointerDown, handlePointerMove, handlePointerUp } = useResizeHandle({
    direction: 'horizontal',
    onResizeStart: () => {
      startPct.current = leftPct;
    },
    onResize: (deltaPx) => {
      if (!containerRef.current) return;
      const width = containerRef.current.getBoundingClientRect().width;
      const deltaPct = (deltaPx / width) * 100;
      setLeftPct(Math.max(20, Math.min(80, startPct.current + deltaPct)));
    },
  });

  return (
    <div
      ref={containerRef}
      className="border-border flex h-48 w-[500px] overflow-hidden rounded-md border"
    >
      <div
        className="bg-sidebar text-muted-foreground flex items-center justify-center text-sm"
        style={{ width: `${leftPct}%` }}
      >
        Left ({Math.round(leftPct)}%)
      </div>
      <ResizeHandle
        direction="horizontal"
        resizing={resizing}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        data-testid="story-resize-horizontal"
      />
      <div className="bg-background text-muted-foreground flex flex-1 items-center justify-center text-sm">
        Right ({Math.round(100 - leftPct)}%)
      </div>
    </div>
  );
}

/** Two side-by-side panels separated by a draggable vertical handle. */
export const Horizontal: Story = {
  render: () => <HorizontalStory />,
};

function VerticalStory() {
  const [height, setHeight] = useState(120);
  const startHeight = useRef(height);

  const { resizing, handlePointerDown, handlePointerMove, handlePointerUp } = useResizeHandle({
    direction: 'vertical',
    onResizeStart: () => {
      startHeight.current = height;
    },
    onResize: (deltaPx) => {
      setHeight(Math.max(60, Math.min(240, startHeight.current + deltaPx)));
    },
  });

  return (
    <div className="border-border w-[500px] overflow-hidden rounded-md border">
      <div
        className="bg-sidebar text-muted-foreground flex items-center justify-center text-sm"
        style={{ height }}
      >
        Top ({height}px)
      </div>
      <ResizeHandle
        direction="vertical"
        resizing={resizing}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        data-testid="story-resize-vertical"
      />
      <div className="bg-background text-muted-foreground flex h-24 items-center justify-center text-sm">
        Bottom
      </div>
    </div>
  );
}

/** Two stacked panels separated by a draggable horizontal handle. */
export const Vertical: Story = {
  render: () => <VerticalStory />,
};
