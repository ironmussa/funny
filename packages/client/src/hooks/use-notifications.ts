import { useCallback, useState } from 'react';

import { createClientLogger } from '@/lib/client-logger';
import { useSettingsStore } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';

const log = createClientLogger('notifications');

export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

function readPermission(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as NotificationPermissionState;
}

/** True if browser supports the Notification API. */
export function isNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** True if the user is currently viewing the given thread (active thread in store). */
function isViewingThread(threadId: string): boolean {
  return useThreadStore.getState().activeThread?.id === threadId;
}

/**
 * Play a short two-tone "ding" using the Web Audio API. No asset required.
 * Safe to call from a user gesture (test button) or after a notification dispatch.
 */
export function playNotificationSound(): void {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) {
      log.warn('audio sound skipped: no AudioContext');
      return;
    }
    const ctx: AudioContext = new Ctx();
    const now = ctx.currentTime;
    const tones: Array<{ freq: number; start: number; dur: number }> = [
      { freq: 880, start: 0, dur: 0.12 },
      { freq: 1320, start: 0.13, dur: 0.18 },
    ];
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = tone.freq;
      const t0 = now + tone.start;
      const t1 = t0 + tone.dur;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    }
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch (err) {
    log.warn('failed to play notification sound', { error: String(err) });
  }
}

/**
 * Show a desktop notification. No-op when unsupported, permission not granted,
 * the user's preference is disabled, or the tab is currently visible.
 */
export type NotificationResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'unsupported' | 'not-granted' | 'disabled' | 'viewing-thread' | 'error';
      error?: string;
    };

export function showAgentNotification(
  title: string,
  body: string,
  opts: {
    tag?: string;
    onClick?: () => void;
    force?: boolean;
    skipIfViewingThreadId?: string;
  } = {},
): NotificationResult {
  if (!isNotificationsSupported()) {
    log.warn('notification skipped: unsupported');
    return { ok: false, reason: 'unsupported' };
  }
  if (Notification.permission !== 'granted') {
    log.warn('notification skipped: permission not granted', {
      permission: Notification.permission,
    });
    return { ok: false, reason: 'not-granted' };
  }
  if (!opts.force && !useSettingsStore.getState().notificationsEnabled) {
    return { ok: false, reason: 'disabled' };
  }
  if (!opts.force && typeof document !== 'undefined' && !document.hidden) {
    return { ok: false, reason: 'viewing-thread' };
  }

  try {
    const notif = new Notification(title, {
      body,
      tag: opts.tag,
      icon: '/favicon.ico',
    });
    notif.onshow = () => log.info('notification shown', { title, tag: opts.tag });
    notif.onerror = (ev) =>
      log.warn('notification error event', { title, tag: opts.tag, ev: String(ev) });
    notif.onclose = () => log.info('notification closed', { title, tag: opts.tag });
    notif.onclick = () => {
      window.focus();
      notif.close();
      opts.onClick?.();
    };
    log.info('notification dispatched', { title, tag: opts.tag, force: !!opts.force });
    if (useSettingsStore.getState().notificationSoundEnabled) {
      playNotificationSound();
    }
    return { ok: true };
  } catch (err) {
    log.warn('failed to show notification', { error: String(err) });
    return { ok: false, reason: 'error', error: String(err) };
  }
}

/**
 * Hook for the settings UI. Exposes the current permission state and a
 * `requestPermission()` action that prompts the browser.
 */
export function useNotifications() {
  const [permission, setPermission] = useState<NotificationPermissionState>(readPermission);

  const requestPermission = useCallback(async (): Promise<NotificationPermissionState> => {
    if (!isNotificationsSupported()) return 'unsupported';
    const result = await Notification.requestPermission();
    const next = result as NotificationPermissionState;
    setPermission(next);
    return next;
  }, []);

  return { permission, requestPermission, supported: isNotificationsSupported() };
}
