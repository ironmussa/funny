import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import * as React from 'react';

import { useCollapsibleContext } from '@/components/ui/collapsible-context';

function CollapsibleTrigger({
  asChild,
  render,
  children,
  disabled: disabledProp,
  onClick,
  ref,
  ...props
}: useRender.ComponentProps<'button'> & { asChild?: boolean }) {
  const context = useCollapsibleContext('CollapsibleTrigger');
  const disabled = disabledProp || context.disabled;
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;
  const resolvedRender = render ?? childElement;

  return useRender({
    defaultTagName: 'button',
    render: resolvedRender,
    ref,
    props: {
      ...mergeProps<'button'>(
        {
          'aria-controls': context.contentId,
          'aria-expanded': context.open,
          disabled,
          type: resolvedRender ? undefined : 'button',
          children: childElement ? undefined : children,
          onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
            onClick?.(event);
            if (event.defaultPrevented || disabled) return;
            context.setOpen(!context.open);
          },
        },
        props,
      ),
      'data-state': context.open ? 'open' : 'closed',
      'data-disabled': disabled ? '' : undefined,
    },
  });
}

export { CollapsibleTrigger };
