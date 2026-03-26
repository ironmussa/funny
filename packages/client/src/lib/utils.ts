import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const TOAST_DURATION = 5000;

/**
 * Icon size tokens — mirrors the `icon-*` CSS utilities in globals.css.
 * Named after the Tailwind text-* scale so you can pair icon-sm with text-sm.
 *
 * Use these when a component needs to pick an icon size programmatically
 * (e.g. mapping a button size prop to an icon class).
 */
export const ICON_SIZE = {
  '2xs': 'icon-2xs', // 10px
  xs: 'icon-xs', // 12px
  sm: 'icon-sm', // 14px
  base: 'icon-base', // 16px
  lg: 'icon-lg', // 20px
  xl: 'icon-xl', // 24px
} as const;

export type IconSize = keyof typeof ICON_SIZE;
