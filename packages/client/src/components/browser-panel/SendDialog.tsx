import { Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import { threadsApi } from '@/lib/api/threads';
import {
  annotationsToMarkdown,
  annotationsToTitle,
  extractImageAttachments,
} from '@/lib/browser-panel-markdown';
import { createClientLogger } from '@/lib/client-logger';
import { metric, startSpan } from '@/lib/telemetry';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';
import { useProjectStore } from '@/stores/project-store';

const log = createClientLogger('browser-panel');

// TODO: dedupe with NewThreadDialog once that component exists / is extracted.
// Right now the compose flow uses NewThreadInput + usePromptInputState which is
// too entangled with the active-thread context to drop into this dialog; for
// v1 we keep a tiny local model list.
const MODEL_OPTIONS = [
  { value: 'sonnet', label: 'Sonnet (recommended)' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
] as const;

export function BrowserPanelFooter() {
  const loadedUrl = useBrowserPanelStore((s) => s.loadedUrl);
  const annotations = useBrowserPanelStore((s) => s.annotations);
  const [open, setOpen] = useState(false);

  const canSend = !!loadedUrl && annotations.length > 0;

  return (
    <>
      <Button
        data-testid="browser-panel-send"
        size="sm"
        disabled={!canSend}
        onClick={() => setOpen(true)}
        className="gap-1.5"
      >
        <Send className="size-3.5" />
        Send
      </Button>
      <SendDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function SendDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const persistedModel = useBrowserPanelStore((s) => s.defaultModel);
  const setDefaultModel = useBrowserPanelStore((s) => s.setDefaultModel);
  const recordSent = useBrowserPanelStore((s) => s.recordSent);
  const closePanel = useBrowserPanelStore((s) => s.closePanel);
  const navigate = useStableNavigate();

  // Project is now derived from the route — the panel is per-project (its
  // entry button lives in `ProjectHeader`), so the user implicitly Sends to
  // the project they're currently in. No selector.
  const projectId = selectedProjectId ?? '';
  const activeProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  const [model, setModel] = useState<string>(persistedModel);
  const [sending, setSending] = useState(false);

  // Re-sync defaults when the dialog opens or persisted model changes.
  useEffect(() => {
    if (open) setModel(persistedModel);
  }, [open, persistedModel]);

  const noProject = !projectId || !activeProject;

  const handleConfirm = async () => {
    const url = useBrowserPanelStore.getState().loadedUrl;
    if (!url || sending || noProject) return;

    // Snapshot the current annotations and lazily serialize the draw canvas
    // into the draw annotation (if any) so the image attachment is fresh.
    const canvas = useBrowserPanelStore.getState().drawCanvasRef;
    let annotations = useBrowserPanelStore.getState().annotations;
    if (canvas) {
      try {
        const dataUrl = canvas.toDataURL('image/png');
        annotations = annotations.map((a) => (a.kind === 'draw' ? { ...a, dataUrl } : a));
      } catch (err) {
        log.warn('canvas toDataURL failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const prompt = annotationsToMarkdown(url, annotations);
    const title = annotationsToTitle(url);
    const images = extractImageAttachments(annotations);
    const annotationCount = annotations.length;

    setSending(true);
    const span = startSpan('browser_panel.create_thread', {
      attributes: { annotation_count: annotationCount },
    });

    try {
      const result = await threadsApi.createThread({
        projectId,
        title,
        mode: 'local',
        model,
        prompt,
        images: images.length > 0 ? images : undefined,
      });

      if (result.isErr()) {
        log.error('createThread failed', {
          type: result.error.type,
          message: result.error.message,
        });
        toast.error(result.error.message);
        span.end('ERROR', result.error.message);
        setSending(false);
        return;
      }

      metric('browser_panel.sent', 1, {
        type: 'sum',
        attributes: { annotation_count: String(annotationCount) },
      });
      span.end('OK');

      const newId = result.value.id;
      // Remember the user's last model choice so it becomes the default next time.
      setDefaultModel(model);
      recordSent({
        threadId: newId,
        title,
        projectId,
        annotationCount,
        sentAt: Date.now(),
      });
      useBrowserPanelStore.getState().reset();
      closePanel();
      onOpenChange(false);
      navigate(`/threads/${newId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('createThread threw', { error: message });
      toast.error(message);
      span.end('ERROR', message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="browser-panel-send-dialog">
        <DialogHeader>
          <DialogTitle>Send annotations to a new thread</DialogTitle>
          <DialogDescription>
            A new thread will be created with your URL and annotations as the first message.
          </DialogDescription>
        </DialogHeader>

        {noProject ? (
          <div
            className="text-sm text-muted-foreground"
            data-testid="browser-panel-send-no-project"
          >
            Open the panel from inside a project to send annotations.
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            <FieldRow label="Project">
              <div
                data-testid="browser-panel-send-project"
                className="rounded-md border border-border bg-muted/30 px-3 py-1.5 text-sm text-foreground"
              >
                {activeProject.name}
              </div>
            </FieldRow>

            <FieldRow label="Mode">
              <Select value="local" disabled>
                <SelectTrigger data-testid="browser-panel-send-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">Local</SelectItem>
                </SelectContent>
              </Select>
            </FieldRow>

            <FieldRow label="Model">
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger data-testid="browser-panel-send-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_OPTIONS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="browser-panel-send-confirm"
            onClick={handleConfirm}
            disabled={noProject || sending}
          >
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_1fr] items-center gap-3">
      <label className="text-sm text-muted-foreground">{label}</label>
      <div>{children}</div>
    </div>
  );
}
