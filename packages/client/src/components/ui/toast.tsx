import { Toast } from '@base-ui/react/toast';
import { CircleCheck, Info, LoaderCircle, OctagonX, TriangleAlert, X } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@/lib/utils';

export type ToastVariant = 'default' | 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface ToastActionOptions {
  label: React.ReactNode;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export interface ToastOptions {
  id?: string | number;
  description?: React.ReactNode;
  duration?: number;
  action?: ToastActionOptions;
  onClose?: () => void;
}

export type ToasterPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export interface ToasterProps {
  position?: ToasterPosition;
  duration?: number;
  limit?: number;
  className?: string;
}

const toastManager = Toast.createToastManager();

function resolveTimeout(duration: number | undefined): number | undefined {
  if (duration === undefined) return undefined;
  if (duration === Infinity || !Number.isFinite(duration)) return 0;
  return duration;
}

function addToast(type: ToastVariant, title: React.ReactNode, options?: ToastOptions): string {
  return toastManager.add({
    id: options?.id !== undefined ? String(options.id) : undefined,
    title,
    description: options?.description,
    type,
    timeout: resolveTimeout(options?.duration),
    priority: type === 'error' ? 'high' : 'low',
    onClose: options?.onClose,
    actionProps: options?.action
      ? {
          children: options.action.label,
          onClick: options.action.onClick,
        }
      : undefined,
  });
}

function toastCallable(title: React.ReactNode, options?: ToastOptions): string {
  return addToast('default', title, options);
}

const toast = Object.assign(toastCallable, {
  success: (title: React.ReactNode, options?: ToastOptions) => addToast('success', title, options),
  error: (title: React.ReactNode, options?: ToastOptions) => addToast('error', title, options),
  info: (title: React.ReactNode, options?: ToastOptions) => addToast('info', title, options),
  warning: (title: React.ReactNode, options?: ToastOptions) => addToast('warning', title, options),
  loading: (title: React.ReactNode, options?: ToastOptions) => addToast('loading', title, options),
  dismiss: (id?: string | number) => {
    toastManager.close(id !== undefined ? String(id) : undefined);
  },
});

const VIEWPORT_POSITION_CLASSES: Record<ToasterPosition, string> = {
  'top-left': 'top-4 left-4',
  'top-center': 'top-4 left-1/2 -translate-x-1/2',
  'top-right': 'top-4 right-4',
  'bottom-left': 'bottom-4 left-4',
  'bottom-center': 'bottom-4 left-1/2 -translate-x-1/2',
  'bottom-right': 'right-4 bottom-4',
};

function ToastIcon({ type }: { type: string | undefined }) {
  switch (type) {
    case 'success':
      return (
        <CircleCheck className="icon-base text-foreground mt-0.5 shrink-0" aria-hidden="true" />
      );
    case 'info':
      return <Info className="icon-base text-foreground mt-0.5 shrink-0" aria-hidden="true" />;
    case 'warning':
      return (
        <TriangleAlert className="icon-base text-foreground mt-0.5 shrink-0" aria-hidden="true" />
      );
    case 'error':
      return <OctagonX className="icon-base text-destructive mt-0.5 shrink-0" aria-hidden="true" />;
    case 'loading':
      return (
        <LoaderCircle
          className="icon-base text-muted-foreground mt-0.5 shrink-0 animate-spin"
          aria-hidden="true"
        />
      );
    default:
      return null;
  }
}

function ToastList({ position }: { position: ToasterPosition }) {
  const { toasts } = Toast.useToastManager();
  const isTop = position.startsWith('top-');
  const swipeDirection: ('up' | 'down' | 'right')[] = isTop ? ['up', 'right'] : ['down', 'right'];

  return (
    <>
      {toasts.map((t) => (
        <Toast.Root
          key={t.id}
          toast={t}
          swipeDirection={swipeDirection}
          data-slot="toast"
          className={cn(
            'group pointer-events-auto relative flex w-full items-start gap-2.5 rounded-lg border border-border bg-background p-3.5 text-foreground shadow-lg select-none',
            'transition-[transform,opacity] duration-200 ease-out',
            'data-starting-style:opacity-0 data-ending-style:opacity-0',
            isTop
              ? 'data-starting-style:-translate-y-2 data-ending-style:-translate-y-2'
              : 'data-starting-style:translate-y-2 data-ending-style:translate-y-2',
            'data-limited:hidden',
          )}
        >
          <ToastIcon type={t.type} />
          <Toast.Content className="min-w-0 flex-1">
            {t.title && (
              <Toast.Title
                data-title=""
                className="line-clamp-4 text-sm leading-snug font-medium break-words"
              />
            )}
            {t.description && (
              <Toast.Description
                data-description=""
                className="text-muted-foreground mt-1 line-clamp-4 text-xs break-words"
              />
            )}
          </Toast.Content>
          {t.actionProps && (
            <Toast.Action className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring shrink-0 self-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-1 focus-visible:outline-none" />
          )}
          <Toast.Close
            aria-label="Close"
            className="text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:ring-ring -mt-0.5 -mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-1 focus-visible:outline-none"
          >
            <X className="icon-sm" aria-hidden="true" />
          </Toast.Close>
        </Toast.Root>
      ))}
    </>
  );
}

function Toaster({
  position = 'bottom-right',
  duration = 5000,
  limit = 5,
  className,
}: ToasterProps) {
  return (
    <Toast.Provider toastManager={toastManager} timeout={duration} limit={limit}>
      <Toast.Portal>
        <Toast.Viewport
          data-slot="toast-viewport"
          className={cn(
            'fixed z-[100] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none pointer-events-none',
            VIEWPORT_POSITION_CLASSES[position],
            className,
          )}
        >
          <ToastList position={position} />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

export { toast, Toaster, toastManager };
