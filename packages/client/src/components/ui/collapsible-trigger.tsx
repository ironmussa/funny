import { Slot } from '@radix-ui/react-slot';
import { type ComponentProps, type Ref } from 'react';

import { useCollapsibleContext } from '@/components/ui/collapsible-context';

function CollapsibleTrigger({
  asChild = false,
  disabled: disabledProp,
  onClick,
  ref,
  ...props
}: ComponentProps<'button'> & {
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  const context = useCollapsibleContext('CollapsibleTrigger');
  const disabled = disabledProp || context.disabled;
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      ref={ref}
      aria-controls={context.contentId}
      aria-expanded={context.open}
      data-state={context.open ? 'open' : 'closed'}
      data-disabled={disabled ? '' : undefined}
      disabled={disabled}
      type={asChild ? undefined : 'button'}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || disabled) return;
        context.setOpen(!context.open);
      }}
    />
  );
}

export { CollapsibleTrigger };
