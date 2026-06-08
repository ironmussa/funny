import { lazy, Suspense } from 'react';

import { PipelineApprovalDialog } from '@/components/PipelineApprovalDialog';
import { Toaster } from '@/components/ui/sonner';
import { WorkflowErrorModal } from '@/components/WorkflowErrorModal';
import { TOAST_DURATION } from '@/lib/utils';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useMediaPreviewStore } from '@/stores/media-preview-store';
import { useUIStore } from '@/stores/ui-store';

// Eagerly start the CommandPalette / FileSearch / TextSearch chunk downloads at
// module-eval time so Ctrl+K and the search dialogs open instantly.
// requestIdleCallback was firing too late on busy main threads and the user saw
// a load delay before the dialog appeared.
const commandPaletteImport = import('@/components/CommandPalette').then((m) => ({
  default: m.CommandPalette,
}));
const CommandPalette = lazy(() => commandPaletteImport);
const fileSearchImport = import('@/components/FileSearchDialog').then((m) => ({
  default: m.FileSearchDialog,
}));
const FileSearchDialog = lazy(() => fileSearchImport);
const textSearchImport = import('@/components/TextSearchDialog').then((m) => ({
  default: m.TextSearchDialog,
}));
const TextSearchDialog = lazy(() => textSearchImport);
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

// Prefetch Monaco (editor dialog + code view) on idle so the first file-open is
// instant. Keeps the code-split (Monaco stays out of the main bundle) while
// removing the on-open download latency.
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => {
    monacoEditorImport();
  });
} else {
  setTimeout(() => {
    monacoEditorImport();
  }, 3000);
}

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
        <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      </Suspense>
      <Suspense>
        <FileSearchDialog open={fileSearchOpen} onOpenChange={setFileSearchOpen} />
      </Suspense>
      <Suspense>
        <TextSearchDialog open={textSearchOpen} onOpenChange={setTextSearchOpen} />
      </Suspense>

      {/* Internal Monaco Editor Dialog (global, lazy-loaded) */}
      <Suspense>
        <MonacoEditorDialog
          open={internalEditorOpen}
          onOpenChange={(open) => {
            if (!open) useInternalEditorStore.getState().closeEditor();
          }}
          filePath={internalEditorFilePath || ''}
          initialContent={internalEditorContent}
        />
      </Suspense>

      {/* Media preview dialog (image/audio/video/pdf — global, lazy-loaded) */}
      <Suspense>
        <MediaPreviewDialog
          open={mediaPreviewOpen}
          onOpenChange={(open) => {
            if (!open) useMediaPreviewStore.getState().close();
          }}
          filePath={mediaPreviewPath}
        />
      </Suspense>
    </>
  );
}
