import { Bot, Hand, MessageSquareWarning, Square, Volume2, VolumeX } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { FIELD_SIZE } from '@/components/ui/control-size';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

/**
 * Shared-control strip for a browser session: who drives a thread-bound page
 * (agent or user) with Take over / Hand back, the page audio on/off, Stop
 * (closes the session for good — closing the panel only detaches a thread
 * session), plus the pending JavaScript dialog, which freezes the page until
 * someone answers it.
 */
export function BrowserControlBar({ style }: { style?: React.CSSProperties }) {
  const sessionThreadId = useBrowserPanelStore((s) => s.sessionThreadId);
  const controller = useBrowserPanelStore((s) => s.controller);
  const dialog = useBrowserPanelStore((s) => s.dialog);
  const setUserControl = useBrowserPanelStore((s) => s.setUserControl);
  const hasSession = useBrowserPanelStore((s) => !!s.sessionId);
  if (!sessionThreadId && !dialog && !hasSession) return null;

  return (
    <div className="flex flex-col gap-1" style={style}>
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
              className="border-border rounded-l-none border-l"
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

/** Page audio on/off and Stop, for any open session. */
function SessionActions() {
  const audioMuted = useBrowserPanelStore((s) => s.audioMuted);
  const setAudioMuted = useBrowserPanelStore((s) => s.setAudioMuted);
  const endBrowserSession = useBrowserPanelStore((s) => s.endBrowserSession);
  return (
    <div className="flex items-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={audioMuted ? 'Turn audio on' : 'Turn audio off'}
            aria-pressed={!audioMuted}
            onClick={() => void setAudioMuted(!audioMuted)}
            className="text-muted-foreground"
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
            variant="ghost"
            size="icon-xs"
            aria-label="Stop browser"
            onClick={() => void endBrowserSession()}
            className="text-muted-foreground hover:text-destructive"
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
