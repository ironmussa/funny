import { useEffect } from 'react';

import { useActiveThreadId } from '@/hooks/use-active-thread-id';
import { useBrowserPanelStore } from '@/stores/browser-panel-store';

import { AnnotationList } from './AnnotationList';
import { BrowserUrlBar } from './BrowserUrlBar';
import { BrowserViewport } from './BrowserViewport';
import { BrowserPanelFooter } from './SendDialog';
import { ToolToolbar } from './ToolToolbar';

/**
 * Browser annotator side panel. Mounted at the app shell as a sibling of
 * `SidebarInset` (see `App.tsx`). Returns null when the panel is closed.
 *
 * Layout (top → bottom):
 *   1. URL bar          (BrowserUrlBar)
 *   2. Tool toolbar     (Browse / Pin / Region / Draw)
 *   3. Viewport         (iframe + transparent React overlay)
 *   4. Annotation list  (AnnotationList)
 *   5. Footer           (Send button + selector)
 */
export function BrowserPanel() {
  const canAnnotate = useBrowserPanelStore(
    (s) =>
      !!s.sessionId &&
      s.sessionStatus === 'ready' &&
      (!s.sessionThreadId || s.controller === 'user'),
  );
  const open = useBrowserPanelStore((s) => s.open);
  const syncActiveThread = useBrowserPanelStore((s) => s.syncActiveThread);
  const activeThreadId = useActiveThreadId();

  // Follow the active thread: show its (agent-shared) browser session, and
  // detach — never close — the previous thread's one.
  useEffect(() => {
    if (open) syncActiveThread(activeThreadId);
  }, [open, activeThreadId, syncActiveThread]);

  if (!open) return null;

  return (
    <div
      data-testid="browser-panel"
      className="bg-card flex h-full min-h-0 w-full flex-col overflow-hidden"
    >
      <section className="border-border shrink-0 border-b" data-section="url-bar">
        <BrowserUrlBar />
      </section>

      {canAnnotate && (
        <section className="border-border shrink-0 border-b" data-section="toolbar">
          <ToolToolbar />
        </section>
      )}

      <section className="relative min-h-0 flex-1 overflow-hidden" data-section="viewport">
        <BrowserViewport />
      </section>

      {canAnnotate && (
        <>
          <section className="border-border max-h-48 shrink-0 border-t" data-section="annotations">
            <AnnotationList />
          </section>

          <section
            className="border-border flex shrink-0 items-center justify-end gap-2 border-t px-3 py-2"
            data-section="footer"
          >
            <BrowserPanelFooter />
          </section>
        </>
      )}
    </div>
  );
}
