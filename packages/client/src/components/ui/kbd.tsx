import { cn } from '@/lib/utils';

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'bg-muted text-muted-foreground pointer-events-none inline-flex h-5 w-fit min-w-5 select-none items-center justify-center gap-1 rounded-sm px-1 font-sans text-xs font-medium',
        "[&_svg:not([class*='size-'])]:size-3",
        // The tooltip surface is always white (see tooltip.tsx), regardless of
        // app theme — so style these chips for a light surface with fixed
        // colors, not theme-dependent --background / dark: variants.
        'in-data-[slot=tooltip-content]:border in-data-[slot=tooltip-content]:border-gray-300 in-data-[slot=tooltip-content]:bg-gray-100 in-data-[slot=tooltip-content]:text-gray-600',
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    />
  );
}

/**
 * Tooltip body that pairs a label with its keyboard shortcut, rendered as
 * `<Kbd>` chips. Designed to drop straight inside a `<TooltipContent>` — `Kbd`
 * already carries tooltip-aware styling. Omit `keys` to render the label alone.
 */
function ShortcutHint({
  label,
  keys,
  className,
}: {
  label: React.ReactNode;
  keys?: readonly string[];
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span>{label}</span>
      {keys && keys.length > 0 ? (
        <KbdGroup>
          {keys.map((k, i) => (
            <Kbd key={`${k}-${i}`}>{k}</Kbd>
          ))}
        </KbdGroup>
      ) : null}
    </span>
  );
}

export { Kbd, KbdGroup, ShortcutHint };
