import {
  ColorPicker,
  ColorPickerAlpha,
  ColorPickerEyeDropper,
  ColorPickerFormat,
  ColorPickerHue,
  ColorPickerOutput,
  ColorPickerSelection,
} from '@/components/ui/color-picker';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const PASTEL_COLORS = [
  '#7CB9E8',
  '#F4A4A4',
  '#A8D5A2',
  '#F9D98C',
  '#C3A6E0',
  '#F2A6C8',
  '#89D4CF',
  '#F9B97C',
];

interface Props {
  projectId: string;
  currentColor?: string;
  onSave: (projectId: string, data: { color: string | null }) => void;
}

/**
 * Per-project color setting: 8 preset pastel chips plus a Popover-based
 * custom color picker. Extracted from GeneralSettings so the parent doesn't
 * import the ColorPicker cluster.
 */
export function ProjectColorPicker({ projectId, currentColor, onSave }: Props) {
  return (
    <div className="border-border/50 flex flex-col gap-3 border-b px-4 py-3.5 last:border-b-0">
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">Project Color</p>
        <p className="text-muted-foreground mt-0.5 text-xs">Pick any color for this project</p>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onSave(projectId, { color: null })}
          className={cn(
            'size-7 rounded-md border-2 transition-all flex items-center justify-center',
            !currentColor
              ? 'border-primary shadow-xs'
              : 'border-border hover:border-muted-foreground',
          )}
          aria-label="No color"
          aria-pressed={!currentColor}
          data-testid="project-color-none"
        >
          <div className="from-muted-foreground/20 to-muted-foreground/40 size-4 rounded-sm bg-linear-to-br" />
        </button>
        {PASTEL_COLORS.map((color) => (
          <button
            key={color}
            onClick={() => onSave(projectId, { color })}
            className={cn(
              'size-7 rounded-md border-2 transition-all',
              currentColor === color
                ? 'border-primary shadow-xs scale-110'
                : 'border-transparent hover:border-muted-foreground',
            )}
            style={{ backgroundColor: color }}
            aria-label={`Color ${color}`}
            aria-pressed={currentColor === color}
          />
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Open custom color picker"
              data-testid="project-color-custom-trigger"
              className={cn(
                'size-8 rounded-lg border-2 shadow-xs cursor-pointer transition-all hover:scale-105',
                currentColor ? 'border-primary/50' : 'border-border',
              )}
              style={{ backgroundColor: currentColor || 'transparent' }}
            >
              {!currentColor && (
                <div className="from-muted-foreground/10 to-muted-foreground/30 flex size-full items-center justify-center rounded-md bg-linear-to-br">
                  <span className="text-muted-foreground text-xs">-</span>
                </div>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-3" align="start">
            <ColorPicker
              value={currentColor || '#7CB9E8'}
              onChange={([r, g, b]) => {
                const hex =
                  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
                onSave(projectId, { color: hex });
              }}
            >
              <ColorPickerSelection className="h-40 rounded-lg" />
              <ColorPickerHue />
              <ColorPickerAlpha />
              <div className="flex items-center gap-2">
                <ColorPickerEyeDropper />
                <ColorPickerOutput />
                <ColorPickerFormat />
              </div>
            </ColorPicker>
          </PopoverContent>
        </Popover>
        <span className="text-muted-foreground text-xs">Custom color</span>
        {currentColor && (
          <span className="text-muted-foreground font-mono text-xs">{currentColor}</span>
        )}
      </div>
    </div>
  );
}
