import {
  Camera,
  ClipboardCopy,
  Eye,
  EyeOff,
  MapPin,
  MousePointer2,
  Pause,
  Pencil,
  Play,
  ScanEye,
  Square,
  Tags,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { annotationsToMarkdown } from '@/lib/browser-panel-markdown';
import { browserSessionClient } from '@/lib/browser-session-client';
import { cn } from '@/lib/utils';
import { useBrowserPanelStore, type Tool } from '@/stores/browser-panel-store';

import { HistoryPopover } from './HistoryPopover';

interface ToolEntry {
  id: Tool;
  label: string;
  Icon: LucideIcon;
}

const TOOLS: ToolEntry[] = [
  { id: 'browse', label: 'Browse', Icon: MousePointer2 },
  { id: 'pin', label: 'Pin', Icon: MapPin },
  { id: 'region', label: 'Region', Icon: Square },
  { id: 'draw', label: 'Draw', Icon: Pencil },
];

export function ToolToolbar() {
  const tool = useBrowserPanelStore((s) => s.tool);
  const setTool = useBrowserPanelStore((s) => s.setTool);
  const overlaysVisible = useBrowserPanelStore((s) => s.overlaysVisible);
  const toggleOverlaysVisibility = useBrowserPanelStore((s) => s.toggleOverlaysVisibility);
  const annotations = useBrowserPanelStore((s) => s.annotations);
  const clearAllAnnotations = useBrowserPanelStore((s) => s.clearAllAnnotations);
  const sessionId = useBrowserPanelStore((s) => s.sessionId);
  const sessionStatus = useBrowserPanelStore((s) => s.sessionStatus);
  const showTestIds = useBrowserPanelStore((s) => s.showTestIds);
  const animationsPaused = useBrowserPanelStore((s) => s.animationsPaused);
  const inspectActive = useBrowserPanelStore((s) => s.inspectActive);
  const toggleShowTestIds = useBrowserPanelStore((s) => s.toggleShowTestIds);
  const toggleAnimationsPaused = useBrowserPanelStore((s) => s.toggleAnimationsPaused);
  const toggleInspectActive = useBrowserPanelStore((s) => s.toggleInspectActive);

  const handleCopyMarkdown = async () => {
    const url = useBrowserPanelStore.getState().loadedUrl ?? '';
    const md = annotationsToMarkdown(url, annotations);
    try {
      await navigator.clipboard.writeText(md);
      toast.success('Annotations copied as markdown');
    } catch {
      toast.error('Could not access clipboard');
    }
  };

  const handleScreenshot = async () => {
    if (!sessionId) {
      toast.error('No active browser session');
      return;
    }
    try {
      const result = (await browserSessionClient.screenshot(sessionId)) as string;
      if (typeof result !== 'string' || !result) {
        toast.error('Empty screenshot response');
        return;
      }
      const binary = atob(result);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/png' });
      // ClipboardItem requires a Promise<Blob> in some browsers, plain Blob in others.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ClipboardItemCtor = (window as any).ClipboardItem;
      if (ClipboardItemCtor && navigator.clipboard && 'write' in navigator.clipboard) {
        await navigator.clipboard.write([new ClipboardItemCtor({ 'image/png': blob })]);
        toast.success('Viewport copied to clipboard');
      } else {
        // Fallback: open in a new tab so the user can save it manually.
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        toast.success('Viewport opened in new tab');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const hasAnnotations = annotations.length > 0;
  const cdpReady = sessionStatus === 'ready' && sessionId !== null;
  // DOM-aware tools (testids, pause animations, inspect, screenshot) all run
  // via CDP and require a live session.
  const domReady = cdpReady;
  const VisibilityIcon = overlaysVisible ? Eye : EyeOff;
  const PauseIcon = animationsPaused ? Play : Pause;

  return (
    <div className="flex items-center gap-1 px-3 py-1.5">
      {TOOLS.map(({ id, label, Icon }) => {
        const active = id === tool;
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <Button
                variant={active ? 'secondary' : 'ghost'}
                size="icon-sm"
                tabIndex={-1}
                data-testid={`browser-panel-tool-${id}`}
                aria-pressed={active}
                onClick={() => setTool(id)}
                className={cn('text-muted-foreground', active && 'text-foreground')}
              >
                <Icon className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{label}</TooltipContent>
          </Tooltip>
        );
      })}

      <Separator orientation="vertical" className="mx-1 h-5" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            data-testid="browser-panel-toggle-visibility"
            aria-pressed={!overlaysVisible}
            onClick={toggleOverlaysVisibility}
            className="text-muted-foreground"
          >
            <VisibilityIcon className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {overlaysVisible ? 'Hide annotations' : 'Show annotations'}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            data-testid="browser-panel-copy-markdown"
            onClick={handleCopyMarkdown}
            disabled={!hasAnnotations}
            className="text-muted-foreground"
          >
            <ClipboardCopy className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Copy as markdown</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            data-testid="browser-panel-clear-all"
            onClick={clearAllAnnotations}
            disabled={!hasAnnotations}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Clear all</TooltipContent>
      </Tooltip>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={showTestIds ? 'secondary' : 'ghost'}
            size="icon-sm"
            tabIndex={-1}
            data-testid="browser-panel-show-testids"
            aria-pressed={showTestIds}
            disabled={!domReady}
            onClick={toggleShowTestIds}
            className={cn('text-muted-foreground', showTestIds && 'text-foreground')}
          >
            <Tags className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {domReady ? 'Show data-testid labels' : 'Requires a live browser session'}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            tabIndex={-1}
            data-testid="browser-panel-screenshot"
            disabled={!cdpReady}
            onClick={handleScreenshot}
            className="text-muted-foreground"
          >
            <Camera className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {cdpReady ? 'Copy screenshot to clipboard' : 'Requires browser session'}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={animationsPaused ? 'secondary' : 'ghost'}
            size="icon-sm"
            tabIndex={-1}
            data-testid="browser-panel-pause-anims"
            aria-pressed={animationsPaused}
            disabled={!domReady}
            onClick={toggleAnimationsPaused}
            className={cn('text-muted-foreground', animationsPaused && 'text-foreground')}
          >
            <PauseIcon className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {domReady
            ? animationsPaused
              ? 'Resume animations'
              : 'Pause animations'
            : 'Requires a live browser session'}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={inspectActive ? 'secondary' : 'ghost'}
            size="icon-sm"
            tabIndex={-1}
            data-testid="browser-panel-inspect-mode"
            aria-pressed={inspectActive}
            disabled={!domReady}
            onClick={toggleInspectActive}
            className={cn('text-muted-foreground', inspectActive && 'text-foreground')}
          >
            <ScanEye className="icon-base" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {domReady ? 'Inspect (hover labels)' : 'Requires a live browser session'}
        </TooltipContent>
      </Tooltip>

      <HistoryPopover />
    </div>
  );
}
