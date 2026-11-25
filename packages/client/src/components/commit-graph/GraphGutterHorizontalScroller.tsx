import { useCallback, type Ref, type UIEvent } from 'react';
import { useTranslation } from 'react-i18next';

export function GraphGutterHorizontalScroller({
  scrollbarRef,
  graphViewportWidth,
  gutterWidth,
  onScrollLeftChange,
}: {
  scrollbarRef?: Ref<HTMLDivElement>;
  graphViewportWidth: number;
  gutterWidth: number;
  onScrollLeftChange: (scrollLeft: number) => void;
}) {
  const { t } = useTranslation();

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      onScrollLeftChange(event.currentTarget.scrollLeft);
    },
    [onScrollLeftChange],
  );

  return (
    <div
      className="border-sidebar-border bg-background shrink-0 border-t py-1 pr-2 pl-3"
      data-testid="graph-gutter-horizontal-scroll"
    >
      <div
        ref={scrollbarRef}
        aria-label={t('graph.gutterHorizontalScroll', 'Scroll graph lanes')}
        title={t('graph.gutterHorizontalScroll', 'Scroll graph lanes')}
        className="scroll-fade-none scrollbar-visible h-2.5 w-[var(--graph-hscroll-viewport-width)] overflow-x-auto overflow-y-hidden"
        style={{ '--graph-hscroll-viewport-width': `${graphViewportWidth}px` }}
        onScroll={handleScroll}
        data-testid="graph-gutter-horizontal-scrollbar"
      >
        <div
          className="h-px w-[var(--graph-hscroll-content-width)]"
          style={{ '--graph-hscroll-content-width': `${gutterWidth}px` }}
        />
      </div>
    </div>
  );
}
