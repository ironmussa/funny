import { lazy, Suspense } from 'react';

import { PipelineApprovalDialog } from '@/components/PipelineApprovalDialog';
import { Toaster } from '@/components/ui/sonner';
import { WorkflowErrorModal } from '@/components/WorkflowErrorModal';
import { TOAST_DURATION } from '@/lib/utils';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useMediaPreviewStore } from '@/stores/media-preview-store';
import { useUIStore } from '@/stores/ui-store';

const commandPaletteImport = () =>
  import('@/components/CommandPalette').then((m) => ({ default: m.CommandPalette }));
const CommandPalette = lazy(commandPaletteImport);
const fileSearchImport = () =>
  import('@/components/FileSearchDialog').then((m) => ({ default: m.FileSearchDialog }));
const FileSearchDialog = lazy(fileSearchImport);
const textSearchImport = () =>
  import('@/components/TextSearchDialog').then((m) => ({ default: m.TextSearchDialog }));
const TextSearchDialog = lazy(textSearchImport);
const CircuitBreakerDialog = lazy(() =>
  import('@/components/CircuitBreakerDialog').then((m) => ({ default: m.CircuitBreakerDialog })),
);
const MonacoEditorDialog = lazy(() =>
  import('@/components/MonacoEditorDialog').then((m) => ({ default: m.MonacoEditorDialog })),
);
const MediaPreviewDialog = lazy(() =>
  import('@/components/MediaPreviewDialog').then((m) => ({ default: m.MediaPreviewDialog })),
);

// Prefetch the CommandPalette and FileSearchDialog chunks on idle so they
// open instantly when triggered.
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => {
    commandPaletteImport();
  });
  requestIdleCallback(() => {
    fileSearchImport();
  });
  requestIdleCallback(() => {
    textSearchImport();
  });
} else {
  setTimeout(() => {
    commandPaletteImport();
  }, 2000);
  setTimeout(() => {
    fileSearchImport();
  }, 2500);
  setTimeout(() => {
    textSearchImport();
  }, 3000);
}

interface OverlayDialogsProps {
  branchSyncDialog: React.ReactNode;
}

/**
 * Stack of global, lazy-loaded overlays rendered at the root of App.tsx:
 * Toaster, branch-sync dialog, workflow error modal, pipeline approval,
 * circuit breaker, command palette, file search, and the internal Monaco
 * editor. All of these mount once at the app root regardless of route.
 *
 * Extracted from App.tsx as part of the god-file split: removes Toaster,
 * WorkflowErrorModal, PipelineApprovalDialog, CircuitBreakerDialog,
 * CommandPalette, FileSearchDialog, MonacoEditorDialog imports +
 * useInternalEditorStore + TOAST_DURATION from App's fan-out.
 */
export function OverlayDialogs({ branchSyncDialog }: OverlayDialogsProps) {
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
      {branchSyncDialog}
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
