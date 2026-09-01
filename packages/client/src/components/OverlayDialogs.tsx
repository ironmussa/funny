import { lazy, Suspense } from 'react';

import { PipelineApprovalDialog } from '@/components/PipelineApprovalDialog';
import { Toaster } from '@/components/ui/sonner';
import { WorkflowErrorModal } from '@/components/WorkflowErrorModal';
import { TOAST_DURATION } from '@/lib/utils';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useMediaPreviewStore } from '@/stores/media-preview-store';
import { useUIStore } from '@/stores/ui-store';

// Keep global overlays out of startup. Starting these imports at module-eval
// time made an ordinary thread reload fetch hundreds of modules that cannot be
// used until the user opens a dialog, competing with the sidebar and chat.
const CommandPalette = lazy(() =>
  import('@/components/CommandPalette').then((m) => ({ default: m.CommandPalette })),
);
const FileSearchDialog = lazy(() =>
  import('@/components/FileSearchDialog').then((m) => ({ default: m.FileSearchDialog })),
);
const TextSearchDialog = lazy(() =>
  import('@/components/TextSearchDialog').then((m) => ({ default: m.TextSearchDialog })),
);
const CircuitBreakerDialog = lazy(() =>
  import('@/components/CircuitBreakerDialog').then((m) => ({ default: m.CircuitBreakerDialog })),
);
// The heavy chunk is `monaco-editor` itself, pulled in statically by
// MonacoCodeView — which MonacoEditorDialog only loads via a nested lazy()
// boundary. So prefetching the dialog alone wouldn't warm Monaco; we prefetch
// BOTH so the first file-open paints already-themed and highlighted (no
// download gap → no white flash / late syntax colors).
const monacoEditorImport = () => {
  void import('@/components/MonacoCodeView');
  return import('@/components/MonacoEditorDialog').then((m) => ({ default: m.MonacoEditorDialog }));
};
const MonacoEditorDialog = lazy(monacoEditorImport);
const MediaPreviewDialog = lazy(() =>
  import('@/components/MediaPreviewDialog').then((m) => ({ default: m.MediaPreviewDialog })),
);

/**
 * Stack of global, lazy-loaded overlays rendered once at the root of App.tsx
 * (inside ThreadProvider, so dialogs that read thread context still work):
 * Toaster, workflow error modal, pipeline approval, circuit breaker, command
 * palette, file/text search, the internal Monaco editor, and media preview.
 */
export function OverlayDialogs() {
  const commandPaletteOpen = useUIStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const fileSearchOpen = useUIStore((s) => s.fileSearchOpen);
  const setFileSearchOpen = useUIStore((s) => s.setFileSearchOpen);
  const textSearchOpen = useUIStore((s) => s.textSearchOpen);
  const setTextSearchOpen = useUIStore((s) => s.setTextSearchOpen);
  const internalEditorOpen = useInternalEditorStore((s) => s.isOpen);
  const internalEditorFilePath = useInternalEditorStore((s) => s.filePath);
  const internalEditorContent = useInternalEditorStore((s) => s.initialContent);
  const mediaPreviewOpen = useMediaPreviewStore((s) => s.isOpen);
  const mediaPreviewPath = useMediaPreviewStore((s) => s.filePath);

  return (
    <>
      <Toaster position="bottom-right" duration={TOAST_DURATION} />
      <WorkflowErrorModal />
      <Suspense>
        <PipelineApprovalDialog />
      </Suspense>
      <Suspense>
        <CircuitBreakerDialog />
      </Suspense>
      <Suspense>
        {commandPaletteOpen && (
          <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
        )}
      </Suspense>
      <Suspense>
        {fileSearchOpen && (
          <FileSearchDialog open={fileSearchOpen} onOpenChange={setFileSearchOpen} />
        )}
      </Suspense>
      <Suspense>
        {textSearchOpen && (
          <TextSearchDialog open={textSearchOpen} onOpenChange={setTextSearchOpen} />
        )}
      </Suspense>

      {/* Internal Monaco Editor Dialog (global, lazy-loaded) */}
      <Suspense>
        {internalEditorOpen && (
          <MonacoEditorDialog
            open={internalEditorOpen}
            onOpenChange={(open) => {
              if (!open) useInternalEditorStore.getState().closeEditor();
            }}
            filePath={internalEditorFilePath || ''}
            initialContent={internalEditorContent}
          />
        )}
      </Suspense>

      {/* Media preview dialog (image/audio/video/pdf — global, lazy-loaded) */}
      <Suspense>
        {mediaPreviewOpen && (
          <MediaPreviewDialog
            open={mediaPreviewOpen}
            onOpenChange={(open) => {
              if (!open) useMediaPreviewStore.getState().close();
            }}
            filePath={mediaPreviewPath}
          />
        )}
      </Suspense>
    </>
  );
}
