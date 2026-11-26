import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import * as React from 'react';

import { CONTROL_ICON, FIELD_SIZE, ICON_SIZE } from '@/components/ui/control-size';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        // A confirm action that deletes or discards: same look as `default`, not red.
        destructive: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        // Toolbar and row actions: a ghost button that stays quiet until hovered.
        muted: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        // Row actions that remove something: quiet until hovered.
        'muted-destructive': 'text-muted-foreground hover:bg-accent hover:text-foreground',
        // A text action that destroys something (delete, discard).
        'ghost-destructive': 'text-foreground hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        // A ghost toolbar button for the view or panel that is showing now.
        active: 'text-foreground hover:bg-accent hover:text-accent-foreground',
        // A ghost toggle button that is on (a view mode, a search option).
        pressed: 'bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground',
        // Ghost buttons tinted by a status: a running command, stop, an open browser.
        'ghost-success': 'text-status-success hover:bg-accent hover:text-status-success/80',
        'ghost-error': 'text-status-error hover:bg-accent hover:text-status-error/80',
        'ghost-info': 'text-status-info hover:bg-accent hover:text-status-info/80',
        // The full-width action closing a list (view all, clear finished), ruled off above.
        'ghost-divided': 'border-t hover:bg-accent hover:text-accent-foreground',
        // A quiet row or menu action whose label turns to the foreground on hover.
        'muted-strong': 'text-muted-foreground hover:bg-accent hover:text-foreground',
        // The selected tool in a toolbar of ghost buttons.
        selected: 'bg-secondary text-foreground hover:bg-secondary/80',
        // A ghost action in the primary color (accept, open the plan).
        'ghost-primary': 'text-primary hover:bg-accent hover:text-primary',
        // An outlined action that needs attention (a server that needs auth).
        'outline-warning':
          'border border-status-warning/30 bg-background text-status-warning hover:bg-status-warning/10 hover:text-accent-foreground',
        // An outlined action that destroys or stops something (stop all).
        'outline-destructive':
          'border border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground',
        // An outlined secondary action (cancel) that stays quiet until hovered.
        'outline-muted':
          'border border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
        // A run action tinted green, brightening on hover.
        'ghost-success-soft': 'text-status-success/80 hover:bg-accent hover:text-status-success',
        // A red text action whose label turns neutral on hover (stop all).
        'destructive-text': 'text-destructive hover:bg-accent hover:text-accent-foreground',
        // A muted toggle that is on, tinted in the primary color (hide factory threads).
        'pressed-primary':
          'bg-primary/10 text-primary hover:bg-accent hover:text-accent-foreground',
        // A muted menu trigger that keeps the foreground color while its menu is open.
        'muted-menu':
          'text-muted-foreground hover:bg-accent hover:text-accent-foreground data-popup-open:text-foreground data-open:text-foreground',
        // A ghost row on the sidebar background (the user menu in the sidebar footer).
        'ghost-sidebar': 'hover:bg-sidebar-accent hover:text-accent-foreground',
      },
      // Field heights / padding / text come from the shared control scale so a
      // text button lines up with an input or select of the same `size`. The
      // square `icon*` buttons are a separate axis (width === height) and keep
      // their own sizes. See control-size.ts.
      size: {
        default: cn(FIELD_SIZE.sm, CONTROL_ICON.sm), // app default density = 32px
        xs: cn(FIELD_SIZE.xs, CONTROL_ICON.xs),
        sm: cn(FIELD_SIZE.sm, CONTROL_ICON.sm),
        md: cn(FIELD_SIZE.md, CONTROL_ICON.md),
        lg: cn(FIELD_SIZE.lg, CONTROL_ICON.lg),
        icon: cn(ICON_SIZE.lg, CONTROL_ICON.md),
        'icon-xs': cn(ICON_SIZE.xs, CONTROL_ICON.sm),
        'icon-sm': cn(ICON_SIZE.sm, CONTROL_ICON.md),
        'icon-md': cn(ICON_SIZE.md, CONTROL_ICON.md),
        // Tiny inline actions inside a row or a chip (20px).
        '2xs': cn('h-5 px-1.5 text-xs', CONTROL_ICON.xs),
        '3xs': cn('h-5 px-1.5 text-2xs', CONTROL_ICON.xs),
        // The `sm` height with tight side padding (show more / less toggles).
        'sm-tight': cn('h-8 px-2 text-sm', CONTROL_ICON.sm),
        // A full-height, square-cornered button in a tab strip.
        strip: cn('h-full rounded-none px-2.5 text-sm', CONTROL_ICON.sm),
        // A 24px toolbar chip with tiny text (the grid size picker).
        chip: cn('h-6 px-2 text-2xs', CONTROL_ICON.sm),
        // A 24px square icon button inside a dense list row.
        'icon-2xs': cn('size-6 p-0 text-sm', CONTROL_ICON.sm),
        // A 20px text action with 4px side padding (dismiss at the end of a banner).
        '3xs-tight': cn('h-5 px-1 text-2xs', CONTROL_ICON.sm),
        // The `xs` height with roomier side padding: the send button beside a plan comment.
        'xs-wide': cn('h-7 px-3 text-xs', CONTROL_ICON.xs),
        // The submit button beside an inline comment field: `xs` height, `sm` text.
        'xs-submit': cn('h-7 px-3 text-sm', CONTROL_ICON.xs),
        // A text action set inside prose (a link button): no box of its own.
        inline: cn('h-auto p-0 text-sm', CONTROL_ICON.sm),
        // An icon button as small as its glyph plus 4px on every side.
        'icon-fit': cn('size-auto p-1', CONTROL_ICON.sm),
        // A row that grows with its content (the sidebar footer's user menu).
        row: cn('h-auto px-1 py-1 text-sm', CONTROL_ICON.sm),
        // A full-width, square-cornered 44px touch row that opens a preview.
        'touch-row': cn('h-11 rounded-none px-3 text-xs', CONTROL_ICON.xs),
      },
      // The right half of a split control: square left corners, ruled off.
      segment: {
        none: '',
        end: 'rounded-l-none border-l border-border',
      },
      // A picker trigger showing a value rather than an action label.
      weight: {
        default: '',
        normal: 'font-normal',
      },
      // Row actions that stay hidden until the pointer is over the row (`group`).
      reveal: {
        none: '',
        hover: 'opacity-0 group-hover:opacity-100',
        'hover-fade': 'opacity-0 transition-opacity group-hover:opacity-100',
        // Same, for a parent marked `group/col` (a live column).
        'col-hover-fade': 'opacity-0 transition-opacity group-hover/col:opacity-100',
      },
      // Space between the icon and the label: tighter than the default 8px in
      // dense toolbars and chips.
      gap: {
        default: '',
        tight: 'gap-1',
        snug: 'gap-1.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      gap: 'default',
      reveal: 'none',
      segment: 'none',
      weight: 'default',
    },
  },
);

export interface ButtonProps
  extends useRender.ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  loading?: boolean;
}

function Button({
  className,
  variant,
  size,
  gap,
  reveal,
  segment,
  weight,
  render,
  loading = false,
  children,
  disabled,
  ref,
  ...props
}: ButtonProps) {
  return useRender({
    defaultTagName: 'button',
    render,
    ref,
    props: mergeProps<'button'>(
      {
        className: cn(buttonVariants({ variant, size, gap, reveal, segment, weight, className })),
        disabled: disabled || loading,
        children: render ? (
          children
        ) : (
          <>
            {loading && <Loader2 className="icon-base animate-spin" />}
            {children}
          </>
        ),
      },
      props,
    ),
  });
}
export { Button, buttonVariants };
