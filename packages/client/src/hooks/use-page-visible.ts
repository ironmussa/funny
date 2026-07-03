import { useSyncExternalStore } from 'react';

function subscribe(onStoreChange: () => void) {
  if (typeof document === 'undefined') return () => {};
  document.addEventListener('visibilitychange', onStoreChange);
  return () => document.removeEventListener('visibilitychange', onStoreChange);
}

function getSnapshot() {
  return typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';
}

export function usePageVisible() {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
