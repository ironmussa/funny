import { type DockviewApi } from 'dockview-react';
import { type MutableRefObject, useEffect, useRef } from 'react';

export type AnimatedPanelToggleOptions = {
  /** Ref to the dockview API. The hook becomes active once `.current` is set. */
  apiRef: MutableRefObject<DockviewApi | null>;
  /** Desired visibility. Flipping triggers a slide-in/out animation. */
  open: boolean;
  /** True iff the managed panel(s) currently exist in the api. */
  exists: (api: DockviewApi) => boolean;
  /** Current size (px) of the managed group along the animated axis, or null. */
  getSize: (api: DockviewApi) => number | null;
  /** Set the size (px) of the managed group along the animated axis. */
  setSize: (api: DockviewApi, size: number) => void;
  /** Add the managed panel(s). `initialSize` is used as a seed for the
   *  open-from-zero case so the first frame doesn't snap to the target. */
  addPanels: (api: DockviewApi, initialSize: number) => void;
  /** Remove the managed panel(s). Called once the close animation reaches 0. */
  removePanels: (api: DockviewApi) => void;
  /** Size (px) to animate TO when opening — usually the persisted width. */
  getOpenSize: () => number;
  /** Fires `(true)` at animation start and `(false)` at end. Use for
   *  persistence-write suppression and neighbor-panel constraint locks. */
  onAnimating?: (animating: boolean, api: DockviewApi) => void;
  /** Animation duration in ms. */
  duration?: number;
};

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Animate the open/close transition of a dockview group along one axis.
 *
 * Dockview's grid uses proportional sizing, so removing a panel redistributes
 * its space to neighbors. To get a smooth slide instead of a hard pop we drive
 * frame-by-frame `setSize` from the current size down to 0 before removing
 * (or from 1 up to the target on open).
 *
 * The caller is responsible — via `onAnimating` — for:
 *   - Suppressing layout persistence during the animation (otherwise the
 *     intermediate frame sizes get written to localStorage and the target
 *     width is lost).
 *   - Locking neighbor panels that should stay fixed (e.g. the left sidebar)
 *     via `panel.api.setConstraints({ min: w, max: w })`.
 */
export function useAnimatedPanelToggle({
  apiRef,
  open,
  exists,
  getSize,
  setSize,
  addPanels,
  removePanels,
  getOpenSize,
  onAnimating,
  duration = 200,
}: AnimatedPanelToggleOptions) {
  const rafRef = useRef<number | null>(null);
  const animatingRef = useRef(false);
  // Tracks the last `open` value we acted on. We only animate when `open`
  // actually flipped — re-renders that change unrelated callback deps must NOT
  // re-trigger an animation, otherwise dragging the splitter and then changing
  // an unrelated prop would snap the pane back to its persisted size. The
  // initial value matches `open` so the first run is a no-op: the parent's
  // own layout-build code is responsible for the initial render.
  const lastOpenRef = useRef<boolean>(open);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    if (lastOpenRef.current === open) return;
    lastOpenRef.current = open;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const isPresent = exists(api);

    if (open && !isPresent) {
      addPanels(api, 1);
      const target = getOpenSize();
      runAnimation({
        rafRef,
        animatingRef,
        from: 1,
        to: target,
        duration,
        api,
        setSize,
        onAnimating,
      });
    } else if (open && isPresent) {
      const current = getSize(api) ?? 1;
      const target = getOpenSize();
      if (current === target) return;
      runAnimation({
        rafRef,
        animatingRef,
        from: current,
        to: target,
        duration,
        api,
        setSize,
        onAnimating,
      });
    } else if (!open && isPresent) {
      const current = getSize(api) ?? 0;
      runAnimation({
        rafRef,
        animatingRef,
        from: current,
        to: 0,
        duration,
        api,
        setSize,
        onAnimating,
        onComplete: () => removePanels(api),
      });
    }
  }, [
    open,
    apiRef,
    exists,
    getSize,
    setSize,
    addPanels,
    removePanels,
    getOpenSize,
    onAnimating,
    duration,
  ]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (animatingRef.current) {
        const api = apiRef.current;
        if (api) onAnimating?.(false, api);
        animatingRef.current = false;
      }
    },
    [apiRef, onAnimating],
  );
}

type RunAnimationParams = {
  rafRef: MutableRefObject<number | null>;
  animatingRef: MutableRefObject<boolean>;
  from: number;
  to: number;
  duration: number;
  api: DockviewApi;
  setSize: (api: DockviewApi, size: number) => void;
  onAnimating?: (animating: boolean, api: DockviewApi) => void;
  onComplete?: () => void;
};

function runAnimation({
  rafRef,
  animatingRef,
  from,
  to,
  duration,
  api,
  setSize,
  onAnimating,
  onComplete,
}: RunAnimationParams) {
  if (!animatingRef.current) {
    animatingRef.current = true;
    onAnimating?.(true, api);
  }
  // Instant path: no animation requested — snap straight to the target,
  // skipping the RAF loop entirely (avoids a one-frame slide flicker).
  if (duration <= 0) {
    setSize(api, to);
    rafRef.current = null;
    onComplete?.();
    animatingRef.current = false;
    onAnimating?.(false, api);
    return;
  }
  const start = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = easeOutCubic(t);
    const value = from + (to - from) * eased;
    setSize(api, value);
    if (t < 1) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      rafRef.current = null;
      onComplete?.();
      animatingRef.current = false;
      onAnimating?.(false, api);
    }
  };
  rafRef.current = requestAnimationFrame(tick);
}
