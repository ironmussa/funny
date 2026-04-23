import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Coordinates a Radix Tooltip wrapping a Radix menu/popover trigger so the
 * tooltip doesn't flash when the menu closes and focus returns to the trigger.
 *
 * Combines two defenses:
 *  - Suppress the tooltip's `open` state while the menu is open (and briefly
 *    after it closes) to absorb the focus-return event.
 *  - Prevent the menu's `onCloseAutoFocus` so focus doesn't snap back to the
 *    trigger at all (also covers submenu close paths where the blur+timeout
 *    race isn't enough).
 */
export function useTooltipMenu() {
  const [tooltipBlocked, setTooltipBlocked] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const blockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      if (blockTimer.current) clearTimeout(blockTimer.current);
      setTooltipBlocked(true);
    } else {
      (document.activeElement as HTMLElement | null)?.blur();
      if (blockTimer.current) clearTimeout(blockTimer.current);
      blockTimer.current = setTimeout(() => setTooltipBlocked(false), 200);
    }
  }, []);

  useEffect(
    () => () => {
      if (blockTimer.current) clearTimeout(blockTimer.current);
    },
    [],
  );

  return {
    tooltipProps: {
      open: !tooltipBlocked && tooltipOpen,
      onOpenChange: setTooltipOpen,
    },
    menuProps: {
      onOpenChange: onMenuOpenChange,
    },
    contentProps: {
      onCloseAutoFocus: (e: Event) => e.preventDefault(),
    },
  };
}
