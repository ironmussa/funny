import * as React from 'react';

const MOBILE_BREAKPOINT = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

const subscribeToMobileQuery = (onStoreChange: () => void) => {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
};

const getMobileSnapshot = () => window.matchMedia(MOBILE_QUERY).matches;

export function useIsMobile() {
  return React.useSyncExternalStore(subscribeToMobileQuery, getMobileSnapshot, () => false);
}
