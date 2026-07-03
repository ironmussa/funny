import { cn } from '@/lib/utils';

const D4C_FRAMES = ['🐇', '🌀', '🐰', '⭐'] as const;

export function D4CAnimation({ size = 'default' }: { size?: 'default' | 'sm' }) {
  return (
    <span
      className={cn(
        'd4c-mark inline-grid items-center justify-center overflow-hidden leading-none',
        size === 'sm' ? 'w-4 text-xs' : 'w-5 text-base',
      )}
    >
      {D4C_FRAMES.map((frame, index) => (
        <span
          key={frame}
          className="d4c-frame col-start-1 row-start-1 inline-block"
          style={{ animationDelay: `${index * 1.8}s` }}
        >
          {frame}
        </span>
      ))}
    </span>
  );
}
