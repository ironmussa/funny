import type {
  ClientLocation,
  LifecycleService,
  LifecycleSnapshot,
  NavigationService,
  Unsubscribe,
} from '@funny/client-core';

export interface BrowserNavigationRuntime {
  location(): ClientLocation;
  push(location: ClientLocation): void;
  replace(location: ClientLocation): void;
  onPopState(listener: () => void): Unsubscribe;
}

export interface BrowserLifecycleRuntime {
  snapshot(): LifecycleSnapshot;
  subscribe(listener: () => void): Unsubscribe;
}

export function createBrowserNavigationService(
  runtime: BrowserNavigationRuntime,
): NavigationService {
  const listeners = new Set<(location: ClientLocation) => void>();
  let stopPopState: Unsubscribe | null = null;
  const publish = (): void => {
    const location = runtime.location();
    for (const listener of listeners) listener(location);
  };
  return {
    current: runtime.location,
    navigate(location, options) {
      if (options?.replace) runtime.replace(location);
      else runtime.push(location);
      publish();
    },
    subscribe(listener) {
      if (listeners.size === 0) stopPopState = runtime.onPopState(publish);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopPopState?.();
          stopPopState = null;
        }
      };
    },
  };
}

export function createBrowserLifecycleService(runtime: BrowserLifecycleRuntime): LifecycleService {
  const listeners = new Set<(snapshot: LifecycleSnapshot) => void>();
  let stopRuntime: Unsubscribe | null = null;
  const publish = (): void => {
    const snapshot = runtime.snapshot();
    for (const listener of listeners) listener(snapshot);
  };
  return {
    current: runtime.snapshot,
    subscribe(listener) {
      if (listeners.size === 0) stopRuntime = runtime.subscribe(publish);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopRuntime?.();
          stopRuntime = null;
        }
      };
    },
  };
}

export function browserNavigationRuntime(win: Window): BrowserNavigationRuntime {
  const location = (): ClientLocation => ({
    pathname: win.location.pathname,
    search: win.location.search,
    hash: win.location.hash,
  });
  const toUrl = (next: ClientLocation): string => `${next.pathname}${next.search}${next.hash}`;
  return {
    location,
    push: (next) => win.history.pushState(null, '', toUrl(next)),
    replace: (next) => win.history.replaceState(null, '', toUrl(next)),
    onPopState(listener) {
      win.addEventListener('popstate', listener);
      return () => win.removeEventListener('popstate', listener);
    },
  };
}

export function browserLifecycleRuntime(win: Window, doc: Document): BrowserLifecycleRuntime {
  return {
    snapshot: () => ({ focused: doc.hasFocus(), visible: doc.visibilityState === 'visible' }),
    subscribe(listener) {
      win.addEventListener('focus', listener);
      win.addEventListener('blur', listener);
      doc.addEventListener('visibilitychange', listener);
      return () => {
        win.removeEventListener('focus', listener);
        win.removeEventListener('blur', listener);
        doc.removeEventListener('visibilitychange', listener);
      };
    },
  };
}
