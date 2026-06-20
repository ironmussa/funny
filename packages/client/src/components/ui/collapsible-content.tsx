import { Slot } from '@radix-ui/react-slot';
import { type ComponentProps, type Ref } from 'react';

import { useCollapsibleContext } from '@/components/ui/collapsible-context';

function CollapsibleContent({
  asChild = false,
  forceMount = false,
  ref,
  ...props
}: ComponentProps<'div'> & {
  asChild?: boolean;
  forceMount?: boolean;
  ref?: Ref<HTMLDivElement>;
}) {
  const context = useCollapsibleContext('CollapsibleContent');
  const Comp = asChild ? Slot : 'div';

  if (!forceMount && !context.open) return null;

  return (
    <Comp
      ref={ref}
      id={context.contentId}
      data-state={context.open ? 'open' : 'closed'}
      hidden={!context.open}
      {...props}
    />
  );
}

export { CollapsibleContent };
