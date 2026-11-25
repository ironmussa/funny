import * as React from 'react';

import { cn } from '@/lib/utils';

import { Button, type ButtonProps } from './button';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

export interface TooltipIconButtonProps extends Omit<ButtonProps, 'children'> {
  /** The icon element to render inside the button */
  children: React.ReactNode;
  /** Tooltip label text */
  tooltip: string;
}

/**
 * A Button wrapped with a Tooltip. Automatically handles the disabled-button
 * case by inserting a `<span>` wrapper so the tooltip still shows on hover.
 */
function TooltipIconButton({
  tooltip,
  children,
  variant = 'ghost',
  size = 'icon-xs',
  className,
  disabled,
  ref,
  ...props
}: TooltipIconButtonProps & { ref?: React.Ref<HTMLButtonElement> }) {
  const button = (
    <Button
      ref={disabled ? undefined : ref}
      variant={variant}
      size={size}
      className={cn(className)}
      disabled={disabled}
      {...props}
    >
      {children}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? (
          // SAFETY: while disabled the span stands in for the button. No caller passes a ref
          // directly; the Radix triggers that pass one through asChild only use the element as an
          // HTMLElement (focus, positioning), which the span is.
          <span ref={ref as React.Ref<HTMLSpanElement>}>{button}</span>
        ) : (
          button
        )}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
export { TooltipIconButton };
