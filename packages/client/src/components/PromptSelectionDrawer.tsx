import { Check, ChevronDown, X } from 'lucide-react';
import { useRef, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { cn } from '@/lib/utils';

export function PromptSelectionDrawer({
  title,
  trigger,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <Drawer open={open} onOpenChange={onOpenChange} autoFocus repositionInputs>
      <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      <DrawerContent
        aria-describedby={undefined}
        data-testid="prompt-selection-drawer"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4">
          <DrawerTitle
            ref={titleRef}
            tabIndex={-1}
            className="min-w-0 py-3 text-base font-semibold outline-hidden"
          >
            {title}
          </DrawerTitle>
          <DrawerClose
            aria-label={t('prompt.mobileSelectors.close', 'Close')}
            className="focus-visible:ring-ring flex size-[48px] shrink-0 items-center justify-center rounded-md focus-visible:ring-2"
          >
            <X className="size-5" />
          </DrawerClose>
        </div>
        <div className="flex min-h-0 flex-col overflow-hidden pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export function PromptSelectionTrigger({
  className,
  children,
  ...props
}: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'flex min-h-[48px] min-w-0 max-w-full items-center gap-1 rounded-md px-2 text-sm hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate">{children}</span>
      <ChevronDown className="size-4 shrink-0 opacity-60" />
    </button>
  );
}

export function PromptSelectionOption({
  selected,
  children,
  className,
  ...props
}: ComponentProps<'button'> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'flex min-h-[48px] w-full items-center gap-3 rounded-md px-4 py-3 text-left text-base hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {selected && <Check className="size-5 shrink-0" />}
    </button>
  );
}
