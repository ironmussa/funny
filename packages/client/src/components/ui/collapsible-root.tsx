import { useCallback, useId, useMemo, useState, type ComponentProps, type Ref } from 'react';

import { CollapsibleContext } from '@/components/ui/collapsible-context';

function Collapsible({
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  disabled = false,
  className,
  children,
  ref,
  ...props
}: ComponentProps<'div'> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
} & { ref?: Ref<HTMLDivElement> }) {
  const contentId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = openProp ?? uncontrolledOpen;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (disabled) return;
      if (openProp === undefined) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [disabled, onOpenChange, openProp],
  );

  const context = useMemo(
    () => ({ contentId, disabled, open, setOpen }),
    [contentId, disabled, open, setOpen],
  );

  return (
    <CollapsibleContext.Provider value={context}>
      <div
        ref={ref}
        data-state={open ? 'open' : 'closed'}
        data-disabled={disabled ? '' : undefined}
        className={className}
        {...props}
      >
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

export { Collapsible };
