import { cn } from '@/lib/utils';

/** Corners of a placeholder: a block, a small square glyph, or a round avatar / dot. */
const SKELETON_CORNERS = {
  default: 'rounded-md',
  square: 'rounded',
  circle: 'rounded-full',
} as const;

function Skeleton({
  className,
  corners = 'default',
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { corners?: keyof typeof SKELETON_CORNERS }) {
  return <div className={cn(SKELETON_CORNERS[corners], 'bg-muted', className)} {...props} />;
}

export { Skeleton };
