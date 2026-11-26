import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import * as React from 'react';

import { cn } from '@/lib/utils';

function Tabs({
  asChild,
  render,
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root> & { asChild?: boolean }) {
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;
  return (
    <TabsPrimitive.Root render={render ?? childElement} {...props}>
      {childElement ? undefined : children}
    </TabsPrimitive.Root>
  );
}

/**
 * Tab styles: `default` pills on a muted track, `pane` pills on the sidebar
 * accent (pane headers), `underline` text tabs over a rule.
 */
type TabsVariant = 'default' | 'pane' | 'underline';

const TABS_LIST_VARIANT: Record<TabsVariant, string> = {
  default: '',
  pane: 'bg-sidebar-accent/50',
  underline: 'gap-0 rounded-none border-b bg-transparent p-0',
};

const TABS_TRIGGER_VARIANT: Record<TabsVariant, string> = {
  default: '',
  pane: '',
  underline:
    'gap-1.5 rounded-none border-b-2 border-transparent px-3 py-1.5 data-active:border-primary data-active:bg-transparent data-active:shadow-none',
};

function TabsList({
  className,
  variant = 'default',
  size = 'default',
  corners = 'default',
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & {
  variant?: TabsVariant;
  /** `sm`: a 28px track for pane headers and compact dialogs. */
  size?: 'default' | 'sm';
  /** `md`: the 6px corners of the controls around it. */
  corners?: 'default' | 'md';
}) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground',
        size === 'sm' && 'h-7 p-0.5',
        TABS_LIST_VARIANT[variant],
        corners === 'md' && 'rounded-md',
        className,
      )}
      {...props}
    />
  );
}
function TabsTrigger({
  className,
  variant = 'default',
  size = 'default',
  focusRing = true,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Tab> & {
  variant?: TabsVariant;
  /** `sm`: a 24px tab for a `size="sm"` list, with a lighter active shadow. */
  size?: 'default' | 'sm';
  /** `false` drops the focus ring (tabs inside a pane header that shows focus itself). */
  focusRing?: boolean;
}) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all hover:bg-muted-foreground/10 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-active:bg-background data-active:text-foreground data-active:shadow-sm',
        size === 'sm' && 'h-6 px-2.5 data-active:shadow-xs',
        TABS_TRIGGER_VARIANT[variant],
        !focusRing && 'focus-visible:ring-0',
        className,
      )}
      {...props}
    />
  );
}
function TabsContent({
  className,
  asChild,
  render,
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Panel> & { asChild?: boolean }) {
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;
  return (
    <TabsPrimitive.Panel
      render={render ?? childElement}
      className={cn(
        'focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/50',
        className,
      )}
      {...props}
    >
      {childElement ? undefined : children}
    </TabsPrimitive.Panel>
  );
}
export { Tabs, TabsList, TabsTrigger, TabsContent };
