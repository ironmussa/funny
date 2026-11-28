import { type ReactNode, Suspense } from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LoadingState } from '@/components/ui/loading-state';

/**
 * What the dockview browser panel shows around the lazily loaded
 * `BrowserPanel`. Without it the panel had a tab and nothing inside while the
 * chunk loaded, or for good when the import failed (a dev server that stopped
 * answering, a deploy that removed the chunk): a spinner while it loads, and
 * the boundary's "Reload page" when the import fails, since `React.lazy`
 * keeps a rejected import.
 */
export function BrowserPanelSlot({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary area="browser-panel">
      <Suspense fallback={<LoadingState testId="browser-panel-loading" label="Loading browser…" />}>
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}
