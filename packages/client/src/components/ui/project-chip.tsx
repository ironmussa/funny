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

/** Darken a hex color by a factor (0 = unchanged, 1 = black). */
export function darkenHex(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = 1 - amount;
  const dr = Math.round(r * f);
  const dg = Math.round(g * f);
  const db = Math.round(b * f);
  return `#${dr.toString(16).padStart(2, '0')}${dg.toString(16).padStart(2, '0')}${db.toString(16).padStart(2, '0')}`;
}

/** Convert [r, g, b] (0-255) to [h, s, l] (h in 0-360, s/l in 0-1). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

/** Convert [h, s, l] (h in 0-360, s/l in 0-1) to a #RRGGBB hex string. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Normalize any hex color into a soft pastel: keep the hue, clamp saturation
 * and force a high lightness so the result is always a light tint. Pairs with
 * contrastText() to yield a colored background + dark text (powerline style).
 */
export function pastelize(hex: string, lightness = 0.82, maxSaturation = 0.7): string {
  const [r, g, b] = hexToRgb(hex);
  const [h, s] = rgbToHsl(r, g, b);
  return hslToHex(h, Math.min(s, maxSaturation), lightness);
}

/** Return '#ffffff' or '#000000' for best contrast against the given background. */
export function contrastText(bgHex: string): string {
  const [r, g, b] = hexToRgb(bgHex);
  return luminance(r, g, b) > 0.18 ? '#000000' : '#ffffff';
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
