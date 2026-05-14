import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Generates a deterministic hue from a string using a simple hash.
 */
function stringToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ((hash % 360) + 360) % 360;
}

/**
 * Converts HSL to RGB. All values in [0, 1] range except h which is [0, 360].
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [r + m, g + m, b + m];
}

/**
 * Returns the relative luminance of an RGB color (values in [0, 1]).
 * Uses the WCAG 2.0 formula.
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const linearize = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * Returns the contrasting text color (black or white) for a given HSL background.
 */
function contrastingTextColor(hue: number, saturation: number, lightness: number): string {
  const [r, g, b] = hslToRgb(hue, saturation, lightness);
  return relativeLuminance(r, g, b) > 0.179 ? '#000' : '#fff';
}

const avatarVariants = cva('relative flex shrink-0 overflow-hidden rounded-full', {
  variants: {
    size: {
      default: 'h-10 w-10',
      xs: 'h-4 w-4',
      sm: 'h-8 w-8',
      lg: 'h-16 w-16',
      xl: 'h-12 w-12',
    },
  },
  defaultVariants: {
    size: 'sm',
  },
});

function Avatar({
  className,
  size,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> &
  VariantProps<typeof avatarVariants> & {
    ref?: React.Ref<React.ElementRef<typeof AvatarPrimitive.Root>>;
  }) {
  return (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn(avatarVariants({ size }), className)}
      {...props}
    />
  );
}
function AvatarImage({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image> & {
  ref?: React.Ref<React.ElementRef<typeof AvatarPrimitive.Image>>;
}) {
  return (
    <AvatarPrimitive.Image
      ref={ref}
      className={cn('aspect-square h-full w-full', className)}
      {...props}
    />
  );
}
function AvatarFallback({
  className,
  name,
  style,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback> & { name?: string } & {
  ref?: React.Ref<React.ElementRef<typeof AvatarPrimitive.Fallback>>;
}) {
  return (
    <AvatarPrimitive.Fallback
      ref={ref}
      className={cn(
        'flex h-full w-full items-center justify-center rounded-full',
        !name && 'bg-muted',
        className,
      )}
      style={
        name
          ? (() => {
              const hue = stringToHue(name);
              const s = 0.6,
                l = 0.8;
              return {
                backgroundColor: `hsl(${hue}, ${s * 100}%, ${l * 100}%)`,
                color: contrastingTextColor(hue, s, l),
                ...style,
              };
            })()
          : style
      }
      {...props}
    />
  );
}
export { Avatar, AvatarImage, AvatarFallback };
