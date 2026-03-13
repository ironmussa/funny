import { Check, Copy } from 'lucide-react';
import * as React from 'react';

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { cn } from '@/lib/utils';

import { Button, type ButtonProps } from './button';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  /** The text to copy to the clipboard */
  value: string;
  /** Label shown in the tooltip before copying (default: "Copy") */
  label?: string;
  /** Label shown in the tooltip after copying (default: "Copied!") */
  copiedLabel?: string;
  /** Duration in ms to show the "copied" state (default: 2000) */
  duration?: number;
}

const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  (
    {
      value,
      label = 'Copy',
      copiedLabel = 'Copied!',
      duration = 2000,
      variant = 'ghost',
      size = 'icon-xs',
      className,
      ...props
    },
    ref,
  ) => {
    const [copied, copy] = useCopyToClipboard(duration);

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            data-testid="copy-button"
            variant={variant}
            size={size}
            className={cn('text-muted-foreground hover:text-foreground', className)}
            onClick={() => copy(value)}
            aria-label={copied ? copiedLabel : label}
            {...props}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? copiedLabel : label}</TooltipContent>
      </Tooltip>
    );
  },
);
CopyButton.displayName = 'CopyButton';

export { CopyButton };
