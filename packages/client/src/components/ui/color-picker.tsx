import * as Slider from '@radix-ui/react-slider';
import Color, { type ColorInstance } from 'color';
import { PipetteIcon } from 'lucide-react';
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  memo,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface ColorPickerContextValue {
  hue: number;
  saturation: number;
  lightness: number;
  alpha: number;
  mode: string;
  setHue: (hue: number) => void;
  setSaturation: (saturation: number) => void;
  setLightness: (lightness: number) => void;
  setAlpha: (alpha: number) => void;
  setMode: (mode: string) => void;
  setColor: (color: ColorInstance) => void;
}

interface ColorState {
  hue: number;
  saturation: number;
  lightness: number;
  alpha: number;
}

const RGB_CHANNEL_KEYS = ['red', 'green', 'blue'] as const;
const HSL_CHANNEL_KEYS = ['hue', 'saturation', 'lightness'] as const;

const tryParseColor = (input: string): ColorInstance | null => {
  try {
    return Color(input.trim());
  } catch {
    return null;
  }
};

const stateFromColor = (color: ColorInstance): ColorState => {
  const [hue, saturation, lightness] = color.hsl().array();
  return {
    hue: Number.isFinite(hue) ? hue : 0,
    saturation: Number.isFinite(saturation) ? saturation : 0,
    lightness: Number.isFinite(lightness) ? lightness : 0,
    alpha: color.alpha() * 100,
  };
};

const rgbaFromState = ({ hue, saturation, lightness, alpha }: ColorState) => {
  const rgba = Color.hsl(hue, saturation, lightness)
    .alpha(alpha / 100)
    .rgb()
    .array();
  return [rgba[0], rgba[1], rgba[2], alpha / 100] as [number, number, number, number];
};

const ColorPickerContext = createContext<ColorPickerContextValue | undefined>(undefined);

export const useColorPicker = () => {
  const context = use(ColorPickerContext);
  if (!context) {
    throw new Error('useColorPicker must be used within a ColorPickerProvider');
  }
  return context;
};

export type ColorPickerProps = Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> & {
  value?: Parameters<typeof Color>[0];
  defaultValue?: Parameters<typeof Color>[0];
  onChange?: (value: [number, number, number, number]) => void;
};

export const ColorPicker = ({
  value,
  defaultValue = '#000000',
  onChange,
  className,
  ...props
}: ColorPickerProps) => {
  const isControlled = value !== undefined;
  const controlledColor = useMemo(
    () => (isControlled ? stateFromColor(Color(value)) : null),
    [isControlled, value],
  );
  const [draftColor, setDraftColor] = useState<ColorState>(() =>
    stateFromColor(Color(isControlled ? value : defaultValue)),
  );
  const colorState = controlledColor ?? draftColor;
  const colorStateRef = useRef(colorState);
  colorStateRef.current = colorState;
  const [mode, setMode] = useState('hex');

  const commitColorState = useCallback(
    (next: ColorState) => {
      colorStateRef.current = next;
      if (!isControlled) {
        setDraftColor(next);
      }
      onChange?.(rgbaFromState(next));
    },
    [isControlled, onChange],
  );

  const setColorPatch = useCallback(
    (patch: Partial<ColorState>) => {
      commitColorState({ ...colorStateRef.current, ...patch });
    },
    [commitColorState],
  );

  const setHue = useCallback((hue: number) => setColorPatch({ hue }), [setColorPatch]);
  const setSaturation = useCallback(
    (saturation: number) => setColorPatch({ saturation }),
    [setColorPatch],
  );
  const setLightness = useCallback(
    (lightness: number) => setColorPatch({ lightness }),
    [setColorPatch],
  );
  const setAlpha = useCallback((alpha: number) => setColorPatch({ alpha }), [setColorPatch]);
  const setColor = useCallback(
    (color: ColorInstance) => {
      commitColorState(stateFromColor(color));
    },
    [commitColorState],
  );

  const { hue, saturation, lightness, alpha } = colorState;

  const contextValue = useMemo(
    () => ({
      hue,
      saturation,
      lightness,
      alpha,
      mode,
      setHue,
      setSaturation,
      setLightness,
      setAlpha,
      setMode,
      setColor,
    }),
    [
      hue,
      saturation,
      lightness,
      alpha,
      mode,
      setHue,
      setSaturation,
      setLightness,
      setAlpha,
      setColor,
    ],
  );

  return (
    <ColorPickerContext.Provider value={contextValue}>
      <div className={cn('flex size-full flex-col gap-4', className)} {...props} />
    </ColorPickerContext.Provider>
  );
};

export type ColorPickerSelectionProps = HTMLAttributes<HTMLDivElement>;

export const ColorPickerSelection = memo(({ className, ...props }: ColorPickerSelectionProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [positionX, setPositionX] = useState(0);
  const [positionY, setPositionY] = useState(0);
  const { hue, setSaturation, setLightness } = useColorPicker();

  const backgroundGradient = useMemo(() => {
    return `linear-gradient(0deg, rgba(0,0,0,1), rgba(0,0,0,0)),
            linear-gradient(90deg, rgba(255,255,255,1), rgba(255,255,255,0)),
            hsl(${hue}, 100%, 50%)`;
  }, [hue]);

  const updatePointerPosition = useCallback(
    (event: PointerEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      setPositionX(x);
      setPositionY(y);
      setSaturation(x * 100);
      const topLightness = x < 0.01 ? 100 : 50 + 50 * (1 - x);
      const lightness = topLightness * (1 - y);
      setLightness(lightness);
    },
    [setLightness, setSaturation],
  );

  const updatePointerPositionEvent = useEffectEvent(updatePointerPosition);

  useEffect(() => {
    if (!isDragging) return;
    const handlePointerMove = (e: PointerEvent) => updatePointerPositionEvent(e);
    const handlePointerUp = () => setIsDragging(false);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isDragging]);

  return (
    <div
      className={cn('relative size-full cursor-crosshair rounded', className)}
      onPointerDown={(e) => {
        e.preventDefault();
        setIsDragging(true);
        updatePointerPosition(e.nativeEvent);
      }}
      ref={containerRef}
      style={{ background: backgroundGradient }}
      {...props}
    >
      <div
        className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
        style={{
          left: `${positionX * 100}%`,
          top: `${positionY * 100}%`,
          boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
        }}
      />
    </div>
  );
});
ColorPickerSelection.displayName = 'ColorPickerSelection';

export type ColorPickerHueProps = ComponentProps<typeof Slider.Root>;

export const ColorPickerHue = ({ className, ...props }: ColorPickerHueProps) => {
  const { hue, setHue } = useColorPicker();
  return (
    <Slider.Root
      className={cn('relative flex h-4 w-full touch-none', className)}
      max={360}
      onValueChange={([h]) => setHue(h)}
      step={1}
      value={[hue]}
      {...props}
    >
      <Slider.Track className="relative my-0.5 h-3 w-full grow rounded-full bg-[linear-gradient(90deg,#FF0000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF,#FF0000)]">
        <Slider.Range className="absolute h-full" />
      </Slider.Track>
      <Slider.Thumb className="border-primary/50 bg-background focus-visible:ring-ring block size-4 rounded-full border shadow-sm transition-colors focus-visible:ring-1 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50" />
    </Slider.Root>
  );
};

export type ColorPickerAlphaProps = ComponentProps<typeof Slider.Root>;

export const ColorPickerAlpha = ({ className, ...props }: ColorPickerAlphaProps) => {
  const { alpha, setAlpha } = useColorPicker();
  return (
    <Slider.Root
      className={cn('relative flex h-4 w-full touch-none', className)}
      max={100}
      onValueChange={([a]) => setAlpha(a)}
      step={1}
      value={[alpha]}
      {...props}
    >
      <Slider.Track
        className="relative my-0.5 h-3 w-full grow rounded-full"
        style={{
          background:
            'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVQ4T2NkYGAQYcAP3uCTZhw1gGGYhAGBZIA/nYDCgBDAm9BGDWAAJyRCgLaBCAAgXwixzAS0pgAAAABJRU5ErkJggg==") left center',
        }}
      >
        <div className="absolute inset-0 rounded-full bg-linear-to-r from-transparent to-black/50" />
        <Slider.Range className="absolute h-full rounded-full bg-transparent" />
      </Slider.Track>
      <Slider.Thumb className="border-primary/50 bg-background focus-visible:ring-ring block size-4 rounded-full border shadow-sm transition-colors focus-visible:ring-1 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50" />
    </Slider.Root>
  );
};

export type ColorPickerEyeDropperProps = ComponentProps<typeof Button>;

export const ColorPickerEyeDropper = ({ className, ...props }: ColorPickerEyeDropperProps) => {
  const { setColor } = useColorPicker();

  const handleEyeDropper = async () => {
    try {
      // @ts-expect-error - EyeDropper API is experimental
      const eyeDropper = new EyeDropper();
      const result = await eyeDropper.open();
      setColor(Color(result.sRGBHex));
    } catch {
      // User cancelled or EyeDropper not supported
    }
  };

  return (
    <Button
      className={cn('shrink-0 text-muted-foreground', className)}
      onClick={handleEyeDropper}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      <PipetteIcon size={16} />
    </Button>
  );
};

export type ColorPickerOutputProps = ComponentProps<typeof SelectTrigger>;

const formats = ['hex', 'rgb', 'css', 'hsl'];

export const ColorPickerOutput = ({ className, ...props }: ColorPickerOutputProps) => {
  const { mode, setMode } = useColorPicker();
  return (
    <Select onValueChange={setMode} value={mode}>
      <SelectTrigger className={cn('h-8 w-20 shrink-0 text-xs', className)} {...props}>
        <SelectValue placeholder="Mode" />
      </SelectTrigger>
      <SelectContent>
        {formats.map((format) => (
          <SelectItem className="text-xs" key={format} value={format}>
            {format.toUpperCase()}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

type EditableInputProps = Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string;
  onCommit: (next: string) => void;
};

const EditableInput = ({ value, onCommit, className, ...props }: EditableInputProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current && inputRef.current) {
      inputRef.current.value = value;
    }
  }, [value]);

  return (
    <Input
      {...props}
      defaultValue={value}
      ref={inputRef}
      className={className}
      onChange={(e) => {
        const v = e.target.value;
        onCommit(v);
      }}
      onFocus={(e) => {
        focusedRef.current = true;
        e.target.select();
      }}
      onBlur={() => {
        focusedRef.current = false;
        if (inputRef.current) {
          inputRef.current.value = value;
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
      }}
    />
  );
};

type AlphaInputProps = {
  alpha: number;
  onAlpha: (alpha: number) => void;
  className?: string;
};

const AlphaInput = ({ alpha, onAlpha, className }: AlphaInputProps) => {
  return (
    <div className="relative">
      <EditableInput
        type="text"
        value={String(Math.round(alpha))}
        onCommit={(raw) => {
          const n = Number(raw);
          if (Number.isFinite(n)) onAlpha(Math.max(0, Math.min(100, n)));
        }}
        className={cn('h-8 w-13 rounded-l-none bg-secondary px-2 text-xs shadow-none', className)}
      />
      <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs">
        %
      </span>
    </div>
  );
};

export type ColorPickerFormatProps = HTMLAttributes<HTMLDivElement>;

export const ColorPickerFormat = ({ className, ...props }: ColorPickerFormatProps) => {
  const { hue, saturation, lightness, alpha, mode, setColor, setAlpha } = useColorPicker();
  const color = Color.hsl(hue, saturation, lightness, alpha / 100);

  if (mode === 'hex') {
    const hex = color.hex();
    return (
      <div
        className={cn(
          'relative flex w-full items-center -space-x-px rounded-md shadow-xs',
          className,
        )}
        {...props}
      >
        <EditableInput
          className="bg-secondary h-8 rounded-r-none px-2 text-xs shadow-none"
          type="text"
          value={hex}
          onCommit={(raw) => {
            const parsed = tryParseColor(raw);
            if (parsed) setColor(parsed.alpha(alpha / 100));
          }}
        />
        <AlphaInput alpha={alpha} onAlpha={setAlpha} />
      </div>
    );
  }

  if (mode === 'rgb') {
    const rgb = color
      .rgb()
      .array()
      .map((v) => Math.round(v));
    const commitChannel = (index: number, raw: string) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      const next = [...rgb];
      next[index] = Math.max(0, Math.min(255, n));
      setColor(Color.rgb(next[0], next[1], next[2]).alpha(alpha / 100));
    };
    return (
      <div
        className={cn('flex items-center -space-x-px rounded-md shadow-xs', className)}
        {...props}
      >
        {rgb.map((value, index) => (
          <EditableInput
            className={cn(
              'h-8 rounded-r-none bg-secondary px-2 text-xs shadow-none',
              index && 'rounded-l-none',
            )}
            key={RGB_CHANNEL_KEYS[index]}
            type="text"
            value={String(value)}
            onCommit={(raw) => commitChannel(index, raw)}
          />
        ))}
        <AlphaInput alpha={alpha} onAlpha={setAlpha} />
      </div>
    );
  }

  if (mode === 'css') {
    const rgb = color
      .rgb()
      .array()
      .map((v) => Math.round(v));
    const cssValue = `rgba(${rgb.join(', ')}, ${Math.round(alpha)}%)`;
    return (
      <div className={cn('w-full rounded-md shadow-xs', className)} {...props}>
        <EditableInput
          className="bg-secondary h-8 w-full px-2 text-xs shadow-none"
          type="text"
          value={cssValue}
          onCommit={(raw) => {
            const parsed = tryParseColor(raw);
            if (parsed) setColor(parsed);
          }}
        />
      </div>
    );
  }

  if (mode === 'hsl') {
    const hsl = color
      .hsl()
      .array()
      .map((v) => Math.round(v));
    const commitChannel = (index: number, raw: string) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      const next = [...hsl];
      const max = index === 0 ? 360 : 100;
      next[index] = Math.max(0, Math.min(max, n));
      setColor(Color.hsl(next[0], next[1], next[2]).alpha(alpha / 100));
    };
    return (
      <div
        className={cn('flex items-center -space-x-px rounded-md shadow-xs', className)}
        {...props}
      >
        {hsl.map((value, index) => (
          <EditableInput
            className={cn(
              'h-8 rounded-r-none bg-secondary px-2 text-xs shadow-none',
              index && 'rounded-l-none',
            )}
            key={HSL_CHANNEL_KEYS[index]}
            type="text"
            value={String(value)}
            onCommit={(raw) => commitChannel(index, raw)}
          />
        ))}
        <AlphaInput alpha={alpha} onAlpha={setAlpha} />
      </div>
    );
  }

  return null;
};
