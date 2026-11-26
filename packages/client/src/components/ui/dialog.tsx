import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import * as React from 'react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DialogDismissHandlers {
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onPointerDownOutside?: (event: Event) => void;
}

const DialogDismissContext = React.createContext<React.RefObject<DialogDismissHandlers> | null>(
  null,
);

function Dialog({
  onOpenChange,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>, 'children'> & {
  children?: React.ReactNode;
}) {
  const dismissHandlersRef = React.useRef<DialogDismissHandlers>({});

  const handleOpenChange: React.ComponentPropsWithoutRef<
    typeof DialogPrimitive.Root
  >['onOpenChange'] = (open, eventDetails) => {
    if (!open) {
      if (eventDetails.reason === 'escape-key' && dismissHandlersRef.current.onEscapeKeyDown) {
        const synthetic = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
        dismissHandlersRef.current.onEscapeKeyDown(synthetic);
        if (synthetic.defaultPrevented) {
          eventDetails.cancel();
          return;
        }
      }
      if (
        eventDetails.reason === 'outside-press' &&
        dismissHandlersRef.current.onPointerDownOutside
      ) {
        const synthetic = new CustomEvent('dialog.pointerDownOutside', { cancelable: true });
        dismissHandlersRef.current.onPointerDownOutside(synthetic);
        if (synthetic.defaultPrevented) {
          eventDetails.cancel();
          return;
        }
      }
    }
    onOpenChange?.(open, eventDetails);
  };

  return (
    <DialogDismissContext value={dismissHandlersRef}>
      <DialogPrimitive.Root onOpenChange={handleOpenChange} {...props}>
        {children}
      </DialogPrimitive.Root>
    </DialogDismissContext>
  );
}

type DialogTriggerProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger> & {
  asChild?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
};

function DialogTrigger({ asChild, render, children, ref, ...props }: DialogTriggerProps) {
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;
  return (
    <DialogPrimitive.Trigger ref={ref} render={render ?? childElement} {...props}>
      {childElement ? undefined : children}
    </DialogPrimitive.Trigger>
  );
}

const DialogPortal = DialogPrimitive.Portal;

type DialogCloseProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close> & {
  asChild?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
};

function DialogClose({ asChild, render, children, ref, ...props }: DialogCloseProps) {
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;
  return (
    <DialogPrimitive.Close ref={ref} render={render ?? childElement} {...props}>
      {childElement ? undefined : children}
    </DialogPrimitive.Close>
  );
}

function DialogOverlay({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Backdrop> & {
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <DialogPrimitive.Backdrop
      ref={ref}
      className={cn(
        'fixed inset-0 z-50 bg-black/60 backdrop-blur-xs data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}

function bridgeAutoFocusHandler(handler?: (event: Event) => void) {
  if (!handler) return undefined;
  return () => {
    const event = new CustomEvent('dialog.autoFocus', { cancelable: true });
    handler(event);
    return !event.defaultPrevented;
  };
}

function DialogContent({
  className,
  overlayClassName,
  flush = false,
  square = false,
  compact = false,
  instant = false,
  initialFocus,
  finalFocus,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  onPointerDownOutside,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Popup> & {
  ref?: React.Ref<HTMLDivElement>;
  /** Extra classes for the backdrop overlay (e.g. to disable its fade animation). */
  overlayClassName?: string;
  /** No padding or gap: the header, body and footer lay out their own sections. */
  flush?: boolean;
  /** Square corners for a full-screen dialog: always, or only below the `md` breakpoint. */
  square?: boolean | 'below-md';
  /** Tighter padding and gap (16px / 12px) for a preview dialog. */
  compact?: boolean;
  /** Open and close at once, with no fade or zoom on the content or the overlay. */
  instant?: boolean;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onPointerDownOutside?: (event: Event) => void;
}) {
  const dismissHandlersRef = React.useContext(DialogDismissContext);
  React.useEffect(() => {
    if (!dismissHandlersRef) return;
    dismissHandlersRef.current = { onEscapeKeyDown, onPointerDownOutside };
    return () => {
      dismissHandlersRef.current = {};
    };
  }, [dismissHandlersRef, onEscapeKeyDown, onPointerDownOutside]);

  return (
    <DialogPortal>
      <DialogOverlay
        className={cn(
          instant && 'data-closed:animate-none data-open:animate-none',
          overlayClassName,
        )}
      />
      <DialogPrimitive.Popup
        ref={ref}
        aria-describedby={undefined}
        initialFocus={initialFocus ?? bridgeAutoFocusHandler(onOpenAutoFocus)}
        finalFocus={finalFocus ?? bridgeAutoFocusHandler(onCloseAutoFocus)}
        className={cn(
          'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-card p-6 shadow-xl duration-100 outline-hidden data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 rounded-lg',
          flush && 'gap-0 p-0',
          square === true && 'rounded-none',
          square === 'below-md' && 'rounded-none md:rounded-lg',
          compact && 'gap-3 p-4',
          instant && 'duration-0 data-closed:animate-none data-open:animate-none',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

/** The displayName of a child element's component, or undefined for text and intrinsic tags. */
function childDisplayName(child: React.ReactNode): string | undefined {
  if (!React.isValidElement(child)) return undefined;
  // SAFETY: an element's type is a tag string or a component; this view only reads the optional
  // displayName, which components may set and strings never have, so a miss reads as undefined.
  return (child.type as { displayName?: string }).displayName;
}

const DialogHeader = ({
  className,
  children,
  bordered = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  /** A header section of a flush dialog: padded, with a rule below it. */
  bordered?: boolean;
}) => {
  const sectionClass = bordered && 'shrink-0 border-b border-border px-4 py-3';
  // Separate DialogTitle and DialogDescription from other children
  const childArray = React.Children.toArray(children);
  const title = childArray.find((child) => childDisplayName(child) === 'DialogTitle');
  const description = childArray.filter((child) => childDisplayName(child) === 'DialogDescription');
  const actions = childArray.filter(
    (child) =>
      !React.isValidElement(child) ||
      (childDisplayName(child) !== 'DialogTitle' &&
        childDisplayName(child) !== 'DialogDescription'),
  );

  // If no direct DialogTitle found, fall back to simple layout (for custom headers)
  if (!title) {
    return (
      <div
        className={cn('relative flex flex-col gap-2 pr-8 sm:text-left', sectionClass, className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          tabIndex={-1}
          className="bg-muted/80 hover:bg-muted focus-visible:ring-ring/50 data-open:bg-accent data-open:text-muted-foreground absolute top-0 right-0 shrink-0 rounded-md p-1.5 opacity-70 transition-[color,background-color,opacity,box-shadow] hover:opacity-100 focus-visible:ring-1 focus-visible:outline-hidden disabled:pointer-events-none"
        >
          <X className="icon-base" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-4 sm:text-left', sectionClass, className)} {...props}>
      {/* Title row: title + extra actions + close button */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">{title}</div>
        <div className="flex shrink-0 items-center gap-2">
          {actions.length > 0 && actions}
          <DialogPrimitive.Close
            tabIndex={-1}
            className="bg-muted/80 hover:bg-muted focus-visible:ring-ring/50 data-open:bg-accent data-open:text-muted-foreground shrink-0 rounded-md p-1.5 opacity-70 transition-[color,background-color,opacity,box-shadow] hover:opacity-100 focus-visible:ring-1 focus-visible:outline-hidden disabled:pointer-events-none"
          >
            <X className="icon-base" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </div>
      </div>
      {/* Description below the title row */}
      {description.length > 0 && description}
    </div>
  );
};
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({
  className,
  bordered = false,
  spaced = false,
  stacked = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  /**
   * A footer section of a flush dialog: padded, with a rule above it (DialogHeader's `bordered`).
   * `roomy` pads 16px on every side; `wide` pads 24px on the sides of a `p-6` dialog.
   */
  bordered?: boolean | 'roomy' | 'wide';
  /** An 8px gap between the buttons, on top of the desktop `space-x-2`. */
  spaced?: boolean;
  /** Full-width buttons stacked 6px apart on every screen size. */
  stacked?: boolean;
}) => (
  <div
    className={cn(
      'flex flex-col-reverse pt-4 sm:flex-row sm:justify-end sm:space-x-2',
      bordered === true && 'shrink-0 gap-2 border-t border-border px-4 py-3 sm:space-x-0',
      bordered === 'roomy' && 'border-t border-border p-4',
      bordered === 'wide' && 'border-t border-border px-6 py-4',
      spaced && 'gap-2 sm:gap-2',
      stacked && 'flex-col gap-1.5 sm:flex-col sm:justify-stretch sm:space-x-0',
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

function DialogTitle({
  className,
  size = 'default',
  withIcon = false,
  mono = false,
  leading = 'none',
  weight = 'semibold',
  truncate = false,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title> & {
  ref?: React.Ref<HTMLHeadingElement>;
  /** `sm` for compact dialogs and panels (text-sm). */
  size?: 'default' | 'sm';
  /** A leading icon beside the title: one row, gap between them, the text clipped. */
  withIcon?: boolean;
  /** A path or other identifier as the title. */
  mono?: boolean;
  /** Line height for a title that may wrap (default `none`). */
  leading?: 'none' | 'tight' | 'snug';
  /** `medium` for a file name as the title. */
  weight?: 'semibold' | 'medium';
  /** Clip a long title with an ellipsis. */
  truncate?: boolean;
}) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn(
        'font-semibold leading-none tracking-tight',
        size === 'sm' ? 'text-sm' : 'text-base',
        withIcon && 'flex min-w-0 items-center gap-2 overflow-hidden',
        mono && 'font-mono',
        leading === 'tight' && 'leading-tight',
        leading === 'snug' && 'leading-snug',
        weight === 'medium' && 'font-medium',
        truncate && 'truncate',
        className,
      )}
      {...props}
    />
  );
}
DialogTitle.displayName = 'DialogTitle';

function DialogDescription({
  className,
  size = 'default',
  asChild,
  render,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description> & {
  ref?: React.Ref<HTMLParagraphElement>;
  asChild?: boolean;
  /** `xs` under a `size="sm"` title. */
  size?: 'default' | 'xs';
}) {
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;
  return (
    <DialogPrimitive.Description
      ref={ref}
      render={render ?? childElement}
      className={cn('text-muted-foreground', size === 'xs' ? 'text-xs' : 'text-sm', className)}
      {...props}
    >
      {childElement ? undefined : children}
    </DialogPrimitive.Description>
  );
}
DialogDescription.displayName = 'DialogDescription';

function DialogCancelButton({
  children = 'Cancel',
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<'button'> & { children?: React.ReactNode } & {
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <DialogPrimitive.Close
      ref={ref}
      type="button"
      className={cn(buttonVariants({ variant: 'outline' }), className)}
      {...props}
    >
      {children}
    </DialogPrimitive.Close>
  );
}

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogCancelButton,
};
