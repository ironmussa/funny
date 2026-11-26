import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import * as React from 'react';

import { cn } from '@/lib/utils';

const TooltipHoverableContext = React.createContext<boolean | undefined>(undefined);

type TooltipProviderProps = Omit<
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>,
  'delay' | 'timeout'
> & {
  delay?: number;
  timeout?: number;
  /** Alias for Base UI `delay` (milliseconds before opening). */
  delayDuration?: number;
  /** Alias for Base UI `timeout` (milliseconds before resetting skip-delay). */
  skipDelayDuration?: number;
  /** Alias for Base UI `disableHoverablePopup` on descendant Tooltips. */
  disableHoverableContent?: boolean;
};

function TooltipProvider({
  delay,
  timeout,
  delayDuration,
  skipDelayDuration,
  disableHoverableContent,
  ...props
}: TooltipProviderProps) {
  return (
    <TooltipHoverableContext value={disableHoverableContent}>
      <TooltipPrimitive.Provider
        delay={delay ?? delayDuration}
        timeout={timeout ?? skipDelayDuration}
        {...props}
      />
    </TooltipHoverableContext>
  );
}

function Tooltip({
  disableHoverablePopup,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>) {
  const disableFromProvider = React.useContext(TooltipHoverableContext);
  return (
    <TooltipPrimitive.Root
      disableHoverablePopup={disableHoverablePopup ?? disableFromProvider}
      {...props}
    />
  );
}

function canMatchSelector(target: EventTarget | null): target is Element {
  return !!target && 'matches' in target && typeof target.matches === 'function';
}

type TooltipTriggerProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger> & {
  asChild?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
};

function TooltipTrigger({
  asChild,
  render,
  children,
  onFocusCapture,
  ref,
  ...props
}: TooltipTriggerProps) {
  const resolvedRender =
    render ?? (asChild && React.isValidElement(children) ? children : undefined);
  const resolvedChildren =
    asChild && !render && React.isValidElement(children) ? undefined : children;

  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      render={resolvedRender}
      onFocusCapture={(event) => {
        onFocusCapture?.(event);
        if (event.defaultPrevented || event.isPropagationStopped()) return;
        const target = event.target;
        if (canMatchSelector(target) && !target.matches(':focus-visible')) {
          event.stopPropagation();
        }
      }}
      {...props}
    >
      {resolvedChildren}
    </TooltipPrimitive.Trigger>
  );
}

const TOOLTIP_VARIANT_CLASSES = {
  default: '',
  /** A full identifier (branch, path, hash, test id): monospace, wrapped at any character. */
  mono: 'max-w-[min(32rem,calc(100vw-2rem))] font-mono break-all',
  /** Several lines of help (a server's details): padded like a small card. */
  padded: 'p-3',
} as const;

type TooltipPositionerProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Positioner>;

type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Popup> &
  Pick<
    TooltipPositionerProps,
    'side' | 'align' | 'sideOffset' | 'alignOffset' | 'collisionPadding'
  > & {
    variant?: keyof typeof TOOLTIP_VARIANT_CLASSES;
    ref?: React.Ref<HTMLDivElement>;
  };

function TooltipContent({
  className,
  side,
  align,
  sideOffset = 4,
  alignOffset,
  collisionPadding,
  variant = 'default',
  ref,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="z-50"
      >
        <TooltipPrimitive.Popup
          ref={ref}
          role="tooltip"
          data-slot="tooltip-content"
          className={cn(
            'z-50 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md animate-in fade-in-0 data-closed:animate-out data-closed:fade-out-0',
            TOOLTIP_VARIANT_CLASSES[variant],
            className,
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
