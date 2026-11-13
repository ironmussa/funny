import { PREFERENCE_KEYS } from '@funny/client-core';

import { LOG_LEVEL_STORAGE_KEY, LOG_NAMESPACE_STORAGE_PREFIX } from '@/lib/log-level-keys';

/**
 * What survives a logout: preferences of the device, not of the account.
 * Everything else in storage may name the previous user's threads, projects,
 * routes, terminals or paths, so it is removed — including keys added later,
 * which count as user data until they are listed here.
 */
const KEPT_KEYS = new Set<string>([
  'theme', // next-themes
  PREFERENCE_KEYS.fontSize,
  PREFERENCE_KEYS.threadViewer,
  PREFERENCE_KEYS.notificationsEnabled,
  PREFERENCE_KEYS.notificationSoundEnabled,
  // Cache of the profile's setup flag so a reload does not flash the setup
  // wizard (`main.tsx`); the next user's profile overwrites it.
  'funny:setupCompleted',
  LOG_LEVEL_STORAGE_KEY,
]);
const KEPT_PREFIXES = [LOG_NAMESPACE_STORAGE_PREFIX];

function isKept(key: string): boolean {
  return KEPT_KEYS.has(key) || KEPT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Remove every stored key except the device preferences above. */
export function clearUserClientState(storage: Storage): void {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && !isKept(key)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

/**
 * Reload at the app root so no in-memory state (stores, drafts, data layer,
 * open terminals) outlives the session, and the URL no longer points at the
 * previous user's thread.
 */
export function reloadAfterLogout(): void {
  window.location.replace('/');
}
