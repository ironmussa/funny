import {
  Bot,
  Check,
  Hand,
  MessageSquareWarning,
  Monitor,
  Smartphone,
  Square,
  Tablet,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { FIELD_SIZE } from '@/components/ui/control-size';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTooltipMenu } from '@/hooks/use-tooltip-menu';
import {
  BROWSER_SESSION_PHONE_PRESETS,
  BROWSER_SESSION_TABLET_PRESETS,
  BROWSER_SESSION_VIEWPORT_HEIGHT,
  BROWSER_SESSION_VIEWPORT_WIDTH,
  type BrowserViewportPreset,
} from '@/lib/browser-session-viewport';
import { cn } from '@/lib/utils';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

/**
 * Shared-control strip for a browser session: who drives a thread-bound page
 * (agent or user) with Take over / Hand back, the page audio on/off, Stop
 * (closes the session for good — closing the panel only detaches a thread
 * session), plus the pending JavaScript dialog, which freezes the page until
 * someone answers it.
 */
export function BrowserControlBar() {
  const sessionThreadId = useBrowserPanelStore((s) => s.sessionThreadId);
  const controller = useBrowserPanelStore((s) => s.controller);
  const dialog = useBrowserPanelStore((s) => s.dialog);
  const setUserControl = useBrowserPanelStore((s) => s.setUserControl);
  const hasSession = useBrowserPanelStore((s) => !!s.sessionId);
  if (!sessionThreadId && !dialog && !hasSession) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        {sessionThreadId && (
          <div
            role="group"
            aria-label="Browser control"
            className="border-border inline-flex w-fit items-center rounded-md border"
            data-testid="browser-panel-control-bar"
          >
            <span
              className={cn(
                'bg-muted/50 inline-flex items-center gap-1.5 rounded-l-md font-medium whitespace-nowrap',
                FIELD_SIZE.xs,
              )}
              data-testid="browser-panel-controller"
            >
              {controller === 'user' ? <Hand className="icon-xs" /> : <Bot className="icon-xs" />}
              {controller === 'user' ? 'You control' : 'Agent controls'}
            </span>
            <Button
              variant="ghost"
              size="xs"
              segment="end"
              onClick={() => void setUserControl(controller !== 'user')}
              data-testid={
                controller === 'user' ? 'browser-panel-hand-back' : 'browser-panel-take-over'
              }
            >
              {controller === 'user' ? 'Hand back to agent' : 'Take over'}
            </Button>
          </div>
        )}
        {hasSession && <SessionActions />}
      </div>
      {dialog && <BrowserDialogPrompt dialog={dialog} />}
    </div>
  );
}

const DESKTOP_PRESET: BrowserViewportPreset = {
  name: 'Desktop',
  width: BROWSER_SESSION_VIEWPORT_WIDTH,
  height: BROWSER_SESSION_VIEWPORT_HEIGHT,
};

const ALL_PRESETS = [
  DESKTOP_PRESET,
  ...BROWSER_SESSION_PHONE_PRESETS,
  ...BROWSER_SESSION_TABLET_PRESETS,
];

/** The first preset of this size (several devices share one), or undefined for a custom size. */
function presetOfSize(width: number, height: number): BrowserViewportPreset | undefined {
  return ALL_PRESETS.find((p) => p.width === width && p.height === height);
}

function presetTestId(preset: BrowserViewportPreset): string {
  return `browser-panel-viewport-${preset.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** Page audio on/off, the viewport size menu and Stop, for any open session. */
function SessionActions() {
  const audioMuted = useBrowserPanelStore((s) => s.audioMuted);
  const setAudioMuted = useBrowserPanelStore((s) => s.setAudioMuted);
  const endBrowserSession = useBrowserPanelStore((s) => s.endBrowserSession);
  return (
    <div className="flex items-center">
      <ViewportMenu />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="muted"
            size="icon-xs"
            aria-label={audioMuted ? 'Turn audio on' : 'Turn audio off'}
            aria-pressed={!audioMuted}
            onClick={() => void setAudioMuted(!audioMuted)}
            data-testid="browser-panel-audio-toggle"
          >
            {audioMuted ? <VolumeX className="icon-xs" /> : <Volume2 className="icon-xs" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {audioMuted ? 'Turn audio on (it plays on the runner machine)' : 'Turn audio off'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="muted-destructive"
            size="icon-xs"
            aria-label="Stop browser"
            onClick={() => void endBrowserSession()}
            data-testid="browser-panel-stop"
          >
            <Square className="icon-xs" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Stop browser (closes the page)</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Device size menu: desktop, or a phone / tablet preset like Chrome DevTools' device toolbar. */
function ViewportMenu() {
  const width = useBrowserPanelStore((s) => s.viewport.width);
  const height = useBrowserPanelStore((s) => s.viewport.height);
  const resizeViewport = useBrowserPanelStore((s) => s.resizeViewport);
  const menu = useTooltipMenu();
  const current = presetOfSize(width, height);
  const Icon = BROWSER_SESSION_PHONE_PRESETS.some((p) => p.width === width)
    ? Smartphone
    : BROWSER_SESSION_TABLET_PRESETS.some((p) => p.width === width)
      ? Tablet
      : Monitor;

  const item = (preset: BrowserViewportPreset) => {
    const selected = preset === current;
    return (
      <DropdownMenuItem
        key={preset.name}
        size="xs"
        onClick={() => void resizeViewport(preset.width, preset.height)}
        aria-checked={selected}
        role="menuitemradio"
        data-testid={presetTestId(preset)}
      >
        <Check className={cn(!selected && 'invisible')} />
        <span className="flex-1">{preset.name}</span>
        <span className="text-muted-foreground ml-4 tabular-nums">
          {preset.width}×{preset.height}
        </span>
      </DropdownMenuItem>
    );
  };

  return (
    <DropdownMenu {...menu.menuProps}>
      <Tooltip {...menu.tooltipProps}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="muted"
              size="icon-xs"
              aria-label="Viewport size"
              data-testid="browser-panel-viewport-menu"
            >
              <Icon className="icon-xs" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {current ? `${current.name} (${width}×${height})` : `Viewport ${width}×${height}`}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        size="xs"
        className="max-h-[70vh] overflow-y-auto"
        {...menu.contentProps}
      >
        {item(DESKTOP_PRESET)}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-2xs px-1.5 py-1">Phones</DropdownMenuLabel>
        {BROWSER_SESSION_PHONE_PRESETS.map(item)}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-2xs px-1.5 py-1">Tablets</DropdownMenuLabel>
        {BROWSER_SESSION_TABLET_PRESETS.map(item)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BrowserDialogPrompt({
  dialog,
}: {
  dialog: { type: string; message: string; defaultValue?: string };
}) {
  const answerDialog = useBrowserPanelStore((s) => s.answerDialog);
  const [promptText, setPromptText] = useState(dialog.defaultValue ?? '');
  const isPrompt = dialog.type === 'prompt';

  return (
    <div
      role="alertdialog"
      aria-label={`Page ${dialog.type} dialog`}
      className="bg-muted/50 border-border flex flex-col gap-1.5 rounded-md border p-2"
      data-testid="browser-panel-dialog"
    >
      <div className="flex items-start gap-1.5">
        <MessageSquareWarning className="icon-sm text-muted-foreground mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{dialog.message || `(${dialog.type})`}</span>
      </div>
      {isPrompt && (
        <Input
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          className="h-7"
          data-testid="browser-panel-dialog-input"
        />
      )}
      <div className="flex justify-end gap-1.5">
        {dialog.type !== 'alert' && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void answerDialog(false)}
            data-testid="browser-panel-dialog-dismiss"
          >
            Cancel
          </Button>
        )}
        <Button
          size="xs"
          onClick={() => void answerDialog(true, isPrompt ? promptText : undefined)}
          data-testid="browser-panel-dialog-accept"
        >
          OK
        </Button>
      </div>
    </div>
  );
}
