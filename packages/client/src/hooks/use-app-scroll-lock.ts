import { useEffect } from 'react';

export const APP_SCROLL_LOCK_CLASS = 'app-shell-scroll-lock';

let appScrollLockCount = 0;

export function useAppScrollLock() {
  useEffect(() => {
    const root = document.documentElement;
    appScrollLockCount += 1;
    root.classList.add(APP_SCROLL_LOCK_CLASS);

    return () => {
      appScrollLockCount = Math.max(0, appScrollLockCount - 1);
      if (appScrollLockCount === 0) {
        root.classList.remove(APP_SCROLL_LOCK_CLASS);
      }
    };
  }, []);
}
