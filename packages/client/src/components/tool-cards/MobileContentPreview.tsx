import { Maximize2 } from 'lucide-react';
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

const FullContentContext = createContext(false);

/** Keep touch gestures on the transcript; only the separate viewer scrolls. */
export function MobileContentPreview({
  children,
  onExpand,
  label,
}: {
  children: ReactNode;
  onExpand?: () => void;
  label?: string;
}) {
  const isMobile = useIsMobile();
  const inViewer = useContext(FullContentContext);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { t } = useTranslation();
  const title = label ?? t('tools.viewFullContent');

  if (!isMobile || inViewer) return children;

  return (
    <>
      <div className="relative h-36 touch-pan-y overflow-clip" data-testid="mobile-content-preview">
        <div inert className="pointer-events-none" aria-hidden="true">
          {children}
        </div>
        <div className="from-card pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t" />
      </div>
      <Button
        size="xs"
        ref={triggerRef}
        variant="ghost"
        className="h-11 w-full justify-start rounded-none px-3"
        onClick={() => (onExpand ? onExpand() : setOpen(true))}
      >
        <Maximize2 className="icon-xs" />
        {title}
      </Button>
      {!onExpand && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            flush
            square
            className="flex h-dvh w-screen max-w-none flex-col"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              triggerRef.current?.focus({ preventScroll: true });
            }}
          >
            <div className="border-border flex shrink-0 items-center gap-3 border-b p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
              <DialogTitle size="sm" className="min-w-0 flex-1">
                {title}
              </DialogTitle>
              <DialogClose asChild>
                <Button variant="outline" className="min-h-11">
                  {t('tools.closeViewer')}
                </Button>
              </DialogClose>
            </div>
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
              <FullContentContext value={true}>{children}</FullContentContext>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/**
 * A tool card's output, ruled off from the card header above it. Desktop keeps
 * its existing scroll area; mobile gets non-scrolling content.
 */
export function ToolContentArea({
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof ScrollArea>, 'variant'>) {
  const isMobile = useIsMobile();
  const inViewer = useContext(FullContentContext);
  if (!isMobile)
    return (
      <ScrollArea variant="divided" className={className} {...props}>
        {children}
      </ScrollArea>
    );
  const contentClass = cn('border-border/40 border-t', className);
  if (inViewer) return <div className={contentClass}>{children}</div>;
  return (
    <MobileContentPreview>
      <div className={contentClass}>{children}</div>
    </MobileContentPreview>
  );
}
