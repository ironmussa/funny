import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

type BlockerState = 'idle' | 'blocked';

export interface NavigationBlocker {
  state: BlockerState;
  proceed: () => void;
  reset: () => void;
}

/**
 * Custom navigation blocker that works with BrowserRouter (non-data router).
 * Intercepts link clicks, popstate (back/forward), and programmatic navigate()
 * calls (which use history.pushState/replaceState) to show a confirmation dialog
 * before navigating away when `shouldBlock` returns true.
 */
export function useNavigationBlock(
  shouldBlock: (current: string, next: string) => boolean,
): NavigationBlocker {
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<BlockerState>('idle');
  const pendingLocationRef = useRef<string | null>(null);
  const shouldBlockRef = useRef(shouldBlock);
  shouldBlockRef.current = shouldBlock;
  const locationRef = useRef(location.pathname);
  locationRef.current = location.pathname;
  // When true, bypass all blocking (used during proceed to avoid re-blocking)
  const proceedingRef = useRef(false);

  const proceed = useCallback(() => {
    const target = pendingLocationRef.current;
    pendingLocationRef.current = null;
    setState('idle');
    if (target) {
      proceedingRef.current = true;
      navigate(target);
      // Reset after a tick so subsequent navigations are blocked again
      setTimeout(() => {
        proceedingRef.current = false;
      }, 0);
    }
  }, [navigate]);

  const reset = useCallback(() => {
    pendingLocationRef.current = null;
    setState('idle');
  }, []);

  useEffect(() => {
    const shouldBlockNow = (current: string, next: string) => {
      if (proceedingRef.current) return false;
      return shouldBlockRef.current(current, next);
    };

    // Intercept clicks on links / elements that trigger navigation
    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('//')) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

      if (shouldBlockNow(locationRef.current, href)) {
        e.preventDefault();
        e.stopPropagation();
        pendingLocationRef.current = href;
        setState('blocked');
      }
    };

    // Intercept popstate (back/forward buttons)
    const handlePopState = () => {
      if (shouldBlockNow(locationRef.current, window.location.pathname)) {
        // Push the current location back to prevent the navigation
        window.history.pushState(null, '', locationRef.current);
        pendingLocationRef.current = window.location.pathname;
        setState('blocked');
      }
    };

    // Intercept programmatic navigation (navigate() calls use history.pushState)
    const origPushState = window.history.pushState.bind(window.history);
    const origReplaceState = window.history.replaceState.bind(window.history);

    window.history.pushState = function (data: any, unused: string, url?: string | URL | null) {
      const nextPath = url ? new URL(url, window.location.origin).pathname : locationRef.current;
      if (shouldBlockNow(locationRef.current, nextPath)) {
        pendingLocationRef.current = nextPath;
        setState('blocked');
        return;
      }
      return origPushState(data, unused, url);
    };

    window.history.replaceState = function (data: any, unused: string, url?: string | URL | null) {
      const nextPath = url ? new URL(url, window.location.origin).pathname : locationRef.current;
      if (shouldBlockNow(locationRef.current, nextPath)) {
        pendingLocationRef.current = nextPath;
        setState('blocked');
        return;
      }
      return origReplaceState(data, unused, url);
    };

    document.addEventListener('click', handleClick, true);
    window.addEventListener('popstate', handlePopState);

    return () => {
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('popstate', handlePopState);
      window.history.pushState = origPushState;
      window.history.replaceState = origReplaceState;
    };
  }, []);

  return { state, proceed, reset };
}
