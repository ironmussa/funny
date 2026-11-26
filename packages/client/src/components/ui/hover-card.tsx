import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card';
import * as React from 'react';

import { cn } from '@/lib/utils';

interface HoverCardDelayContextValue {
  openDelay?: number;
  closeDelay?: number;
}

const HoverCardDelayContext = React.createContext<HoverCardDelayContextValue>({});

type HoverCardProps = React.ComponentPropsWithoutRef<typeof PreviewCardPrimitive.Root> & {
  openDelay?: number;
  closeDelay?: number;
};

function HoverCard({ openDelay, closeDelay, ...props }: HoverCardProps) {
  const delayValue = React.useMemo(() => ({ openDelay, closeDelay }), [openDelay, closeDelay]);
  return (
    <HoverCardDelayContext value={delayValue}>
      <PreviewCardPrimitive.Root {...props} />
    </HoverCardDelayContext>
  );
}

type HoverCardTriggerProps = React.ComponentPropsWithoutRef<typeof PreviewCardPrimitive.Trigger> & {
  asChild?: boolean;
  ref?: React.Ref<HTMLAnchorElement>;
};

function HoverCardTrigger({
  asChild,
  render,
  children,
  delay,
  closeDelay,
  ref,
  ...props
}: HoverCardTriggerProps) {
  const delayCtx = React.useContext(HoverCardDelayContext);
  const resolvedRender =
    render ?? (asChild && React.isValidElement(children) ? children : undefined);
  const resolvedChildren =
    asChild && !render && React.isValidElement(children) ? undefined : children;

  return (
    <PreviewCardPrimitive.Trigger
      ref={ref}
      render={resolvedRender}
      delay={delay ?? delayCtx.openDelay}
      closeDelay={closeDelay ?? delayCtx.closeDelay}
      {...props}
    >
      {resolvedChildren}
    </PreviewCardPrimitive.Trigger>
  );
}

type PreviewCardPositionerProps = React.ComponentPropsWithoutRef<
  typeof PreviewCardPrimitive.Positioner
>;

type HoverCardContentProps = React.ComponentPropsWithoutRef<typeof PreviewCardPrimitive.Popup> &
  Pick<
    PreviewCardPositionerProps,
    'side' | 'align' | 'sideOffset' | 'alignOffset' | 'collisionPadding'
  > & {
    ref?: React.Ref<HTMLDivElement>;
  };

function HoverCardContent({
  className,
  side,
  align = 'center',
  sideOffset = 4,
  alignOffset,
  collisionPadding,
  ref,
  ...props
}: HoverCardContentProps) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="z-50"
      >
        <PreviewCardPrimitive.Popup
          ref={ref}
          className={cn(
            'z-50 w-64 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--transform-origin)',
            className,
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
