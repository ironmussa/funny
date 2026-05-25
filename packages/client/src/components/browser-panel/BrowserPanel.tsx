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
  const open = useBrowserPanelStore((s) => s.open);
  if (!open) return null;

  return (
    <div
      data-testid="browser-panel"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-card"
    >
      <section className="shrink-0 border-b border-border" data-section="url-bar">
        <BrowserUrlBar />
      </section>

      <section className="shrink-0 border-b border-border" data-section="toolbar">
        <ToolToolbar />
      </section>

      <section className="relative min-h-0 flex-1 overflow-hidden" data-section="viewport">
        <BrowserViewport />
      </section>

      <section className="max-h-48 shrink-0 border-t border-border" data-section="annotations">
        <AnnotationList />
      </section>

      <section
        className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-2"
        data-section="footer"
      >
        <BrowserPanelFooter />
      </section>
    </div>
  );
}
