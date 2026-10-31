import { useEffect, type RefObject } from 'react';

const SECTION_ATTR = 'data-turn-section';
const BAR_ATTR = 'data-turn-end-for';
const HOVERED_ATTR = 'data-hovered';

/**
 * Reveals a turn's completion bar while the pointer is over any row of that
 * turn. Rows carry `data-turn-section`, bars carry `data-turn-end-for`; the
 * toggle is imperative so hovering never re-renders the (virtualized) list.
 */
export function useTurnEndHover(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let current: string | null = null;

    const setHovered = (sectionId: string | null) => {
      if (sectionId === current) return;
      container
        .querySelectorAll(`[${HOVERED_ATTR}]`)
        .forEach((bar) => bar.removeAttribute(HOVERED_ATTR));
      current = sectionId;
      if (!sectionId) return;
      container
        .querySelectorAll(`[${BAR_ATTR}="${CSS.escape(sectionId)}"]`)
        .forEach((bar) => bar.setAttribute(HOVERED_ATTR, ''));
    };

    const onOver = (event: MouseEvent) => {
      const row =
        event.target instanceof Element ? event.target.closest(`[${SECTION_ATTR}]`) : null;
      setHovered(row?.getAttribute(SECTION_ATTR) ?? null);
    };
    const onLeave = () => setHovered(null);

    container.addEventListener('mouseover', onOver);
    container.addEventListener('mouseleave', onLeave);
    return () => {
      container.removeEventListener('mouseover', onOver);
      container.removeEventListener('mouseleave', onLeave);
    };
  }, [containerRef]);
}
