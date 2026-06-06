import { lazy, Suspense, useRef } from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ResizeHandle, useResizeHandle } from '@/components/ui/resize-handle';
import { useUIStore } from '@/stores/ui-store';

const reviewPaneImport = () =>
  import('@/components/ReviewPane').then((m) => ({ default: m.ReviewPane }));
const ReviewPane = lazy(reviewPaneImport);
const ActivityPane = lazy(() =>
  import('@/components/ActivityPane').then((m) => ({ default: m.ActivityPane })),
);
const ProjectFilesPane = lazy(() =>
  import('@/components/ProjectFilesPane').then((m) => ({ default: m.ProjectFilesPane })),
);

// Prefetch the ReviewPane chunk on idle so it opens instantly when triggered.
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(() => {
    reviewPaneImport();
  });
} else {
  setTimeout(() => {
    reviewPaneImport();
  }, 3000);
}

interface RightPaneProps {
  /** When false, the pane is hidden (width animates to 0 and inner unmounts). */
  visible: boolean;
}

/**
 * The right-side pane that toggles between ReviewPane / ProjectFilesPane /
 * ActivityPane based on `rightPaneTab`. Manages its own drag-to-resize handle
 * and width-animation wrapper.
 *
 * Extracted from App.tsx as part of the god-file split: removes ReviewPane,
 * ActivityPane, ProjectFilesPane, ResizeHandle, useResizeHandle imports from
 * App's fan-out.
 */
export function RightPane({ visible }: RightPaneProps) {
  const reviewPaneWidth = useUIStore((s) => s.reviewPaneWidth);
  const setReviewPaneWidth = useUIStore((s) => s.setReviewPaneWidth);
  const setReviewPaneResizing = useUIStore((s) => s.setReviewPaneResizing);
  const rightPaneTab = useUIStore((s) => s.rightPaneTab);

  // Drag-to-resize for the right pane. Capture starting width on pointerdown
  // so the first drag responds immediately (no unit-normalization snap).
  const dragStartWidthVw = useRef(0);
  const { resizing, handlePointerDown, handlePointerMove, handlePointerUp } = useResizeHandle({
    direction: 'horizontal',
    onResizeStart: () => {
      dragStartWidthVw.current = useUIStore.getState().reviewPaneWidth;
      setReviewPaneResizing(true);
    },
    onResize: (deltaPx) => {
      const deltaVw = (deltaPx / window.innerWidth) * 100;
      // Dragging the handle right shrinks the right pane.
      setReviewPaneWidth(dragStartWidthVw.current - deltaVw);
    },
    onResizeEnd: () => {
      setReviewPaneResizing(false);
    },
  });

  return (
    <>
      {/* Resize handle between center and right pane — only when right pane is shown */}
      {visible && (
        <ResizeHandle
          direction="horizontal"
          resizing={resizing}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          data-testid="right-pane-resize-handle"
        />
      )}

      {/* Right panel — Review / Tasks / Activity. Wrapper stays mounted so
          width can toggle open/closed; inner content unmounts when hidden. */}
      <div
        className="bg-sidebar flex min-w-0 shrink-0 flex-col overflow-hidden"
        style={{ width: visible ? `${reviewPaneWidth}vw` : 0 }}
      >
        {visible && (
          <div className="min-h-0 flex-1 overflow-hidden" style={{ width: `${reviewPaneWidth}vw` }}>
            <ErrorBoundary area="right-pane">
              <Suspense>
                {rightPaneTab === 'review' ? (
                  <ReviewPane />
                ) : rightPaneTab === 'files' ? (
                  <ProjectFilesPane />
                ) : (
                  <ActivityPane />
                )}
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
      </div>
    </>
  );
}
