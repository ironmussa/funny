import { Check, Copy } from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { cn } from '@/lib/utils';

import { Button, type ButtonProps } from './button';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children' | 'value'> {
  /**
   * The text to copy, or an async getter for text that must be fetched first
   * (the icon feedback stays identical either way).
   */
  value: string | (() => Promise<string>);
  /** Label shown in the tooltip before copying (default: "Copy") */
  label?: string;
  /** Label shown in the tooltip after copying (default: "Copied!") */
  copiedLabel?: string;
  /** Duration in ms to show the "copied" state (default: 2000) */
  duration?: number;
}

function CopyButton({
  value,
  label = 'Copy',
  copiedLabel = 'Copied!',
  duration = 2000,
  variant = 'ghost',
  size = 'icon-xs',
  className,
  ref,
  ...props
}: CopyButtonProps & { ref?: React.Ref<HTMLButtonElement> }) {
  const { t } = useTranslation();
  const [copied, copy] = useCopyToClipboard(duration);

  const handleClick = async () => {
    let text: string;
    try {
      text = typeof value === 'string' ? value : await value();
    } catch {
      toast.error(t('common.copyFailed', 'Could not copy to clipboard'));
      return;
    }
    await copy(text);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          data-testid="copy-button"
          variant={variant}
          size={size}
          className={cn('text-muted-foreground hover:text-foreground', className)}
          onClick={handleClick}
          aria-label={copied ? copiedLabel : label}
          {...props}
        >
          {copied ? (
            <Check className="copy-feedback-icon text-green-600" />
          ) : (
            <Copy className="copy-feedback-icon" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? copiedLabel : label}</TooltipContent>
    </Tooltip>
  );
}
export { CopyButton };
