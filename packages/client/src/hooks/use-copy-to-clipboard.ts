import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

/** Copy feedback is shown only after the clipboard accepts the text. */
export function useCopyToClipboard(duration = 2000): [boolean, (text: string) => Promise<boolean>] {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timeoutRef.current);
    };
  }, []);

  const copy = useCallback(
    async (text: string) => {
      clearTimeout(timeoutRef.current);
      setCopied(false);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        if (mounted.current) toast.error(t('common.copyFailed', 'Could not copy to clipboard'));
        return false;
      }
      if (mounted.current) {
        setCopied(true);
        toast.success(t('common.copied', 'Copied'));
        clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), duration);
      }
      return true;
    },
    [duration, t],
  );

  return [copied, copy];
}
