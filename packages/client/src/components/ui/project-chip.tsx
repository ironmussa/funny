import { cn } from '@/lib/utils';

const PALETTE = [
  '#7CB9E8', // pastel blue
  '#F4A4A4', // pastel red
  '#A8D5A2', // pastel green
  '#F9D98C', // pastel amber
  '#C3A6E0', // pastel violet
  '#F2A6C8', // pastel pink
  '#89D4CF', // pastel teal
  '#F9B97C', // pastel orange
];

/** Pick a deterministic color from the palette based on a string hash. */
export function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** Parse a hex color (#RGB or #RRGGBB) into [r, g, b] (0-255). */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  if (h.length === 3) {
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Relative luminance per WCAG 2.0 (0 = black, 1 = white). */
function luminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** Return '#ffffff' or '#000000' for best contrast against the given background. */
export function contrastText(bgHex: string): string {
  const [r, g, b] = hexToRgb(bgHex);
  return luminance(r, g, b) > 0.4 ? '#000000' : '#ffffff';
}

interface ProjectChipProps {
  name: string;
  color?: string;
  size?: 'xs' | 'sm' | 'default';
  className?: string;
}

export function ProjectChip({ name, color, size = 'default', className }: ProjectChipProps) {
  const c = color || colorFromName(name);
  return (
    <span
      className={cn(
        'rounded inline-block truncate font-medium',
        size === 'xs'
          ? 'text-[9px] leading-tight px-1 py-px'
          : size === 'sm'
            ? 'text-[10px] leading-tight px-1 py-px'
            : 'text-xs px-1.5 py-0.5',
        className,
      )}
      style={{
        backgroundColor: c,
        color: contrastText(c),
      }}
    >
      {name}
    </span>
  );
}
