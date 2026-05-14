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
        'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}
function DialogContent({
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Content>>;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        aria-describedby={undefined}
        className={cn(
          'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-card p-6 shadow-xl duration-100 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] rounded-lg',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}
const DialogHeader = ({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) => {
  // Separate DialogTitle and DialogDescription from other children
  const childArray = React.Children.toArray(children);
  const title = childArray.find(
    (child) => React.isValidElement(child) && (child.type as any)?.displayName === 'DialogTitle',
  );
  const description = childArray.filter(
    (child) =>
      React.isValidElement(child) && (child.type as any)?.displayName === 'DialogDescription',
  );
  const actions = childArray.filter(
    (child) =>
      !React.isValidElement(child) ||
      ((child.type as any)?.displayName !== 'DialogTitle' &&
        (child.type as any)?.displayName !== 'DialogDescription'),
  );

  // If no direct DialogTitle found, fall back to simple layout (for custom headers)
  if (!title) {
    return (
      <div className={cn('relative flex flex-col gap-2 pr-8 sm:text-left', className)} {...props}>
        {children}
        <DialogPrimitive.Close
          tabIndex={-1}
          className="absolute right-0 top-0 shrink-0 rounded-md bg-muted/80 p-1.5 opacity-70 transition-all hover:bg-muted hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"
        >
          <X className="icon-base" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-4 sm:text-left', className)} {...props}>
      {/* Title row: title + extra actions + close button */}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">{title}</div>
        <div className="flex shrink-0 items-center gap-2">
          {actions.length > 0 && actions}
          <DialogPrimitive.Close
            tabIndex={-1}
            className="shrink-0 rounded-md bg-muted/80 p-1.5 opacity-70 transition-all hover:bg-muted hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"
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

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse pt-4 sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

function DialogTitle({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title> & {
  ref?: React.Ref<React.ComponentRef<typeof DialogPrimitive.Title>>;
}) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-base font-semibold leading-none tracking-tight', className)}
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
