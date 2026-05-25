import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { useUIStore } from '@/stores/ui-store';

const isTauri = !!(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__;
const isPreviewWindow = !!(window as unknown as { __PREVIEW_MODE__: unknown }).__PREVIEW_MODE__;

interface AnnotatorCapturePayload {
  markdown: string;
  url: string;
}

/**
 * Listens for `annotator:capture` events emitted by the Rust `annotator_send`
 * command. On receipt, opens the scratch-compose flow with the captured
 * markdown pre-filled in the prompt input.
 *
 * No-op outside Tauri or in the preview window (which has its own UI shell).
 */
export function useTauriAnnotatorEvents() {
  const navigate = useNavigate();
  const startNewScratchThread = useUIStore((s) => s.startNewScratchThread);
  const setComposePrefillPrompt = useUIStore((s) => s.setComposePrefillPrompt);

  useEffect(() => {
    if (!isTauri || isPreviewWindow) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const off = await listen<AnnotatorCapturePayload>('annotator:capture', (event) => {
        const md = event.payload?.markdown?.trim();
        if (!md) return;
        // Order matters: set the prefill BEFORE entering compose so the
        // NewThreadInput picks it up on mount (one-shot via ref).
        setComposePrefillPrompt(md);
        startNewScratchThread();
        navigate('/scratch/new');
        toast.success('Annotation captured — sent to compose');
      });
      if (cancelled) {
        off();
      } else {
        unlisten = off;
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [navigate, startNewScratchThread, setComposePrefillPrompt]);
}
