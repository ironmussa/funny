import { cn } from '@/lib/utils';

const DEFAULT_COLOR = '#3b82f6';

interface ProjectChipProps {
  name: string;
  color?: string;
  size?: 'sm' | 'default';
  className?: string;
}

export function ProjectChip({ name, color, size = 'default', className }: ProjectChipProps) {
  const c = color || DEFAULT_COLOR;
  return (
    <span
      className={cn(
        'rounded inline-block truncate',
        size === 'sm' ? 'text-[10px] leading-tight px-1 py-px' : 'text-xs px-1.5 py-0.5',
        className,
      )}
      style={{
        backgroundColor: `${c}1A`,
        color: c,
      }}
    >
      {name}
    </span>
  );
}
