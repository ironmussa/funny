import { useLayoutEffect, useRef } from 'react';

import { useAppScrollLock } from '@/hooks/use-app-scroll-lock';

/** Keep the mobile shell inside the visible area, including when the keyboard pans it. */
export function useMobileViewport() {
  const ref = useRef<HTMLDivElement>(null);
  useAppScrollLock();

  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      if (!ref.current || (viewport && viewport.scale !== 1)) return;
      ref.current.style.height = `${viewport?.height ?? window.innerHeight}px`;
      ref.current.style.top = `${viewport?.offsetTop ?? 0}px`;
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  return ref;
}
