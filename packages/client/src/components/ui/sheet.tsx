'use client';

import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

const Sheet = SheetPrimitive.Root;

const SheetPortal = SheetPrimitive.Portal;

function SheetOverlay({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Backdrop> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <SheetPrimitive.Backdrop
      className={cn(
        'fixed inset-0 z-50 bg-black/80 backdrop-blur-xs data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0',
        className,
      )}
      {...props}
      ref={ref}
    />
  );
}

const sheetVariants = cva(
  'fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-open:animate-in data-closed:animate-out data-closed:duration-300 data-open:duration-500',
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b data-closed:slide-out-to-top data-open:slide-in-from-top',
        bottom:
          'inset-x-0 bottom-0 border-t data-closed:slide-out-to-bottom data-open:slide-in-from-bottom',
        left: 'inset-y-0 left-0 h-full w-3/4 border-r data-closed:slide-out-to-left data-open:slide-in-from-left sm:max-w-sm',
        right:
          'inset-y-0 right-0 h-full w-3/4 border-l data-closed:slide-out-to-right data-open:slide-in-from-right sm:max-w-sm',
      },
    },
    defaultVariants: {
      side: 'right',
    },
  },
);

function bridgeAutoFocusHandler(handler?: (event: Event) => void) {
  if (!handler) return undefined;
  return () => {
    const event = new CustomEvent('sheet.autoFocus', { cancelable: true });
    handler(event);
    return !event.defaultPrevented;
  };
}

interface SheetContentProps
  extends
    React.ComponentPropsWithoutRef<typeof SheetPrimitive.Popup>,
    VariantProps<typeof sheetVariants> {
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

function SheetContent({
  side = 'right',
  className,
  children,
  initialFocus,
  finalFocus,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ref,
  ...props
}: SheetContentProps & { ref?: React.Ref<HTMLDivElement> }) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        ref={ref}
        initialFocus={initialFocus ?? bridgeAutoFocusHandler(onOpenAutoFocus)}
        finalFocus={finalFocus ?? bridgeAutoFocusHandler(onCloseAutoFocus)}
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="focus-visible:ring-ring/50 data-open:bg-secondary absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-1 focus-visible:outline-hidden disabled:pointer-events-none">
          <X className="icon-base" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-2 text-center sm:text-left', className)} {...props} />
);
SheetHeader.displayName = 'SheetHeader';

function SheetTitle({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title> & {
  ref?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <SheetPrimitive.Title
      ref={ref}
      className={cn('text-lg font-semibold text-foreground', className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  asChild,
  render,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description> & {
  asChild?: boolean;
  ref?: React.Ref<HTMLParagraphElement>;
}) {
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;
  return (
    <SheetPrimitive.Description
      ref={ref}
      render={render ?? childElement}
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    >
      {childElement ? undefined : children}
    </SheetPrimitive.Description>
  );
}

export { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription };
