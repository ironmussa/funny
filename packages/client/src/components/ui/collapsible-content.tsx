import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import * as React from 'react';

import { useCollapsibleContext } from '@/components/ui/collapsible-context';

function CollapsibleContent({
  asChild,
  render,
  children,
  forceMount = false,
  ref,
  ...props
}: useRender.ComponentProps<'div'> & {
  asChild?: boolean;
  forceMount?: boolean;
}) {
  const context = useCollapsibleContext('CollapsibleContent');
  const childElement = asChild && !render && React.isValidElement(children) ? children : undefined;

  return useRender({
    defaultTagName: 'div',
    render: render ?? childElement,
    ref,
    enabled: forceMount || context.open,
    props: {
      ...mergeProps<'div'>(
        {
          id: context.contentId,
          hidden: !context.open,
          children: childElement ? undefined : children,
        },
        props,
      ),
      'data-state': context.open ? 'open' : 'closed',
    },
  });
}

export { CollapsibleContent };
