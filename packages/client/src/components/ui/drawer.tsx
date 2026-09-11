import type { ComponentProps } from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';

import { cn } from '@/lib/utils';

const Drawer = DrawerPrimitive.Root;
const DrawerTrigger = DrawerPrimitive.Trigger;
const DrawerClose = DrawerPrimitive.Close;
const DrawerTitle = DrawerPrimitive.Title;
const DrawerDescription = DrawerPrimitive.Description;

function DrawerContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DrawerPrimitive.Content>) {
  return (
    <DrawerPrimitive.Portal>
      <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <DrawerPrimitive.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-xl border bg-background text-foreground outline-hidden',
          className,
        )}
        {...props}
      >
        <div
          aria-hidden="true"
          className="bg-muted mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full"
        />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPrimitive.Portal>
  );
}

export { Drawer, DrawerTrigger, DrawerClose, DrawerTitle, DrawerDescription, DrawerContent };
