import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import * as React from 'react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Overlay>>;
}) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'fixed inset-0 z-50 bg-black/60 backdrop-blur-xs data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}
function DialogContent({
  className,
  overlayClassName,
  flush = false,
  square = false,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Content>>;
  /** Extra classes for the backdrop overlay (e.g. to disable its fade animation). */
  overlayClassName?: string;
  /** No padding or gap: the header, body and footer lay out their own sections. */
  flush?: boolean;
  /** Square corners for a full-screen dialog: always, or only below the `md` breakpoint. */
  square?: boolean | 'below-md';
}) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        ref={ref}
        aria-describedby={undefined}
        className={cn(
          'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-card p-6 shadow-xl duration-100 outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 rounded-lg',
          flush && 'gap-0 p-0',
          square === true && 'rounded-none',
          square === 'below-md' && 'rounded-none md:rounded-lg',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
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
          className="bg-muted/80 hover:bg-muted focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-0 right-0 shrink-0 rounded-md p-1.5 opacity-70 transition-[color,background-color,opacity,box-shadow] hover:opacity-100 focus-visible:ring-1 focus-visible:outline-hidden disabled:pointer-events-none"
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
            className="bg-muted/80 hover:bg-muted focus-visible:ring-ring/50 data-[state=open]:bg-accent data-[state=open]:text-muted-foreground shrink-0 rounded-md p-1.5 opacity-70 transition-[color,background-color,opacity,box-shadow] hover:opacity-100 focus-visible:ring-1 focus-visible:outline-hidden disabled:pointer-events-none"
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
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  /** A footer section of a flush dialog: padded, with a rule above it (DialogHeader's `bordered`). */
  bordered?: boolean;
}) => (
  <div
    className={cn(
      'flex flex-col-reverse pt-4 sm:flex-row sm:justify-end sm:space-x-2',
      bordered && 'shrink-0 gap-2 border-t border-border px-4 py-3 sm:space-x-0',
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
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Title>>;
  /** `sm` for compact dialogs and panels (text-sm). */
  size?: 'default' | 'sm';
  /** A leading icon beside the title: one row, gap between them, the text clipped. */
  withIcon?: boolean;
  /** A path or other identifier as the title. */
  mono?: boolean;
}) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn(
        'font-semibold leading-none tracking-tight',
        size === 'sm' ? 'text-sm' : 'text-base',
        withIcon && 'flex min-w-0 items-center gap-2 overflow-hidden',
        mono && 'font-mono',
        className,
      )}
      {...props}
    />
  );
}
DialogTitle.displayName = 'DialogTitle';

function DialogDescription({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Description>>;
}) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
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
    <DialogPrimitive.Close asChild>
      <button
        ref={ref}
        type="button"
        className={cn(buttonVariants({ variant: 'outline' }), className)}
        {...props}
      >
        {children}
      </button>
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
