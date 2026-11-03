import { Bot, Hand, MessageSquareWarning } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { FIELD_SIZE } from '@/components/ui/control-size';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

/**
 * Shared-control strip for a thread-bound browser session: who drives the
 * page (agent or user) with Take over / Hand back, plus the pending JavaScript
 * dialog — which freezes the page until someone answers it.
 */
export function BrowserControlBar({ style }: { style?: React.CSSProperties }) {
  const sessionThreadId = useBrowserPanelStore((s) => s.sessionThreadId);
  const controller = useBrowserPanelStore((s) => s.controller);
  const dialog = useBrowserPanelStore((s) => s.dialog);
  const setUserControl = useBrowserPanelStore((s) => s.setUserControl);
  if (!sessionThreadId && !dialog) return null;

  return (
    <div className="flex flex-col gap-1" style={style}>
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
      {dialog && <BrowserDialogPrompt dialog={dialog} />}
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
