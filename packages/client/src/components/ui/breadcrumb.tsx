import { Slot } from '@radix-ui/react-slot';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
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
  ref,
  ...props
}: React.ComponentPropsWithoutRef<'a'> & { asChild?: boolean } & {
  ref?: React.Ref<HTMLAnchorElement>;
}) {
  const Comp = asChild ? Slot : 'a';
  return (
    <Comp
      ref={ref}
      className={cn('transition-colors hover:text-foreground', className)}
      {...props}
    />
  );
}
function BreadcrumbPage({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<'span'> & { ref?: React.Ref<HTMLSpanElement> }) {
  return (
    <span
      ref={ref}
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn('font-medium text-foreground', className)}
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

const BreadcrumbEllipsis = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    role="presentation"
    aria-hidden="true"
    className={cn('flex h-9 w-9 items-center justify-center', className)}
    {...props}
  >
    <MoreHorizontal className="icon-base" />
    <span className="sr-only">More</span>
  </span>
);
BreadcrumbEllipsis.displayName = 'BreadcrumbEllipsis';

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
};
