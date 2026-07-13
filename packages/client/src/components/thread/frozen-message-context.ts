import { createContext, type RefObject } from 'react';

/**
 * When present, the shared row renderer swaps live `MessageContent` for the
 * intersection-hydrated `FrozenMessage` (frozen viewer only). The virtual
 * viewer never provides this context, so its rendering is unchanged.
 *
 * `scrollRootRef` is the scroll viewport used as the IntersectionObserver root
 * so each message can tell when it is far enough offscreen to freeze.
 */
export interface FrozenViewerContextValue {
  scrollRootRef: RefObject<HTMLElement | null>;
}

export const FrozenViewerContext = createContext<FrozenViewerContextValue | null>(null);
