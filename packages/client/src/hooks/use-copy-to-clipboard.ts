import { useCallback, useRef, useState } from 'react';

/**
 * Hook for copying text to clipboard with a temporary "copied" state.
 * Returns `[copied, copy]` — call `copy(text)` to write to clipboard
 * and flip `copied` to `true` for `duration` ms (default 2000).
 */
export function useCopyToClipboard(duration = 2000): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const copy = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), duration);
    },
    [duration],
  );

  return [copied, copy];
}
