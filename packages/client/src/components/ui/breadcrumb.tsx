import { Slot } from '@radix-ui/react-slot';
import { ChevronRight } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

function Breadcrumb({
  ref,
  ...props
}: React.ComponentPropsWithoutRef<'nav'> & { separator?: React.ReactNode } & {
  ref?: React.Ref<HTMLElement>;
}) {
  return <nav ref={ref} aria-label="breadcrumb" {...props} />;
}
function BreadcrumbList({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<'ol'> & { ref?: React.Ref<HTMLOListElement> }) {
  return (
    <ol
      ref={ref}
      className={cn(
        'flex items-center gap-1.5 text-sm text-muted-foreground sm:gap-2.5 overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}
function BreadcrumbItem({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<'li'> & { ref?: React.Ref<HTMLLIElement> }) {
  return (
    <li
      ref={ref}
      className={cn('inline-flex items-center gap-1.5 min-w-0', className)}
      {...props}
    />
  );
}
function BreadcrumbLink({
  asChild,
  className,
  truncate = false,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<'a'> & { asChild?: boolean } & {
  ref?: React.Ref<HTMLAnchorElement>;
  /** Clip a long name with an ellipsis. */
  truncate?: boolean;
}) {
  const Comp = asChild ? Slot : 'a';
  return (
    <Comp
      ref={ref}
      className={cn('transition-colors hover:text-foreground', truncate && 'truncate', className)}
      {...props}
    />
  );
}
function BreadcrumbPage({
  className,
  truncate = false,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<'span'> & {
  ref?: React.Ref<HTMLSpanElement>;
  /** Clip a long name with an ellipsis. */
  truncate?: boolean;
}) {
  return (
    <span
      ref={ref}
      aria-current="page"
      className={cn('font-medium text-foreground', truncate && 'truncate', className)}
      {...props}
    />
  );
}
const BreadcrumbSeparator = ({ children, className, ...props }: React.ComponentProps<'li'>) => (
  <li
    role="presentation"
    aria-hidden="true"
    className={cn('[&>svg]:h-3.5 [&>svg]:w-3.5', className)}
    {...props}
  >
    {children ?? <ChevronRight />}
  </li>
);
BreadcrumbSeparator.displayName = 'BreadcrumbSeparator';

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
};
