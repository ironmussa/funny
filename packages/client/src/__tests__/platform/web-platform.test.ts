import {
  createEndpointPolicy,
  type ClientDiagnostic,
  type ClientLocation,
  type LifecycleSnapshot,
} from '@funny/client-core';
import { describe, expect, test, vi } from 'vitest';

import { createClientComposition } from '@/platform/client-composition';
import { createBrowserEffectService } from '@/platform/web/browser-effects';
import {
  createBrowserLifecycleService,
  createBrowserNavigationService,
} from '@/platform/web/browser-navigation';
import { createBrowserStorageService } from '@/platform/web/browser-storage';
import {
  createBrowserTransportService,
  resolveWebEnvironment,
} from '@/platform/web/browser-transport';
import { installBrowserCircuitConnectivity } from '@/platform/web/circuit-connectivity';

const diagnostics = () => {
  const values: ClientDiagnostic[] = [];
  return { values, service: { report: (value: ClientDiagnostic) => values.push(value) } };
};

describe('web client platform', () => {
  test('preserves browser and Tauri endpoint environment inputs', () => {
    const browser = resolveWebEnvironment({ isTauri: false, pageOrigin: 'https://funny.test' });
    expect(browser).toMatchObject({
      hostMode: 'browser',
      pageOrigin: 'https://funny.test',
      localServerPort: 3001,
    });
    expect(createEndpointPolicy(browser)).toMatchObject({
      apiBase: '/api',
      realtimeOrigin: 'https://funny.test',
    });

    const tauri = resolveWebEnvironment({
      isTauri: true,
      pageOrigin: 'tauri://localhost',
      serverPort: '5002',
      allowedContainerOrigins: ' https://one.test,https://two.test ',
    });
    expect(tauri).toEqual({
      hostMode: 'tauri',
      pageOrigin: 'tauri://localhost',
      localServerPort: 5002,
      remoteOriginAllowlist: ['https://one.test', 'https://two.test'],
    });
    expect(createEndpointPolicy(tauri)).toMatchObject({
      apiBase: 'http://localhost:5002/api',
      realtimeOrigin: 'http://localhost:5002',
    });
  });

  test('reads existing storage keys, publishes local/cross-window changes, and tolerates denial', () => {
    const stored = new Map([['funny:settings', '{"theme":"one-dark"}']]);
    let onStorage: ((event: StorageEvent) => void) | undefined;
    const stop = vi.fn();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    } as unknown as Storage;
    const log = diagnostics();
    const service = createBrowserStorageService(
      {
        storage,
        addStorageListener(listener) {
          onStorage = listener;
          return stop;
        },
      },
      log.service,
    );
    const changes: unknown[] = [];
    const unsubscribe = service.subscribe((change) => changes.push(change));

    expect(service.read('funny:settings')).toBe('{"theme":"one-dark"}');
    service.write('funny:settings', '{"theme":"dracula"}');
    onStorage?.({
      storageArea: storage,
      key: 'funny:settings',
      newValue: 'remote',
    } as StorageEvent);
    expect(changes).toEqual([
      { key: 'funny:settings', value: '{"theme":"dracula"}' },
      { key: 'funny:settings', value: 'remote' },
    ]);
    unsubscribe();
    expect(stop).toHaveBeenCalledOnce();

    const denied = createBrowserStorageService(
      {
        storage: {
          getItem: () => {
            throw new Error('denied');
          },
        } as unknown as Storage,
        addStorageListener: () => () => undefined,
      },
      log.service,
    );
    expect(denied.read('key')).toBeNull();
    expect(log.values.at(-1)?.capability).toBe('storage');
  });

  test('publishes navigation/lifecycle snapshots and removes host listeners', () => {
    let location: ClientLocation = { pathname: '/', search: '', hash: '' };
    let pop: (() => void) | undefined;
    const stopPop = vi.fn();
    const navigation = createBrowserNavigationService({
      location: () => location,
      push: (next) => {
        location = next;
      },
      replace: (next) => {
        location = next;
      },
      onPopState: (listener) => {
        pop = listener;
        return stopPop;
      },
    });
    const locations: ClientLocation[] = [];
    const stopNavigation = navigation.subscribe((next) => locations.push(next));
    navigation.navigate({ pathname: '/threads/1', search: '?tab=files', hash: '' });
    pop?.();
    expect(locations).toHaveLength(2);
    stopNavigation();
    expect(stopPop).toHaveBeenCalledOnce();

    let snapshot: LifecycleSnapshot = { focused: true, visible: true };
    let changed: (() => void) | undefined;
    const stopHost = vi.fn();
    const lifecycle = createBrowserLifecycleService({
      snapshot: () => snapshot,
      subscribe: (listener) => {
        changed = listener;
        return stopHost;
      },
    });
    const snapshots: LifecycleSnapshot[] = [];
    const stopLifecycle = lifecycle.subscribe((next) => snapshots.push(next));
    snapshot = { focused: false, visible: false };
    changed?.();
    expect(snapshots).toEqual([{ focused: false, visible: false }]);
    stopLifecycle();
    expect(stopHost).toHaveBeenCalledOnce();
  });

  test('delivers effects and reports unsupported optional notifications', () => {
    const log = diagnostics();
    const toast = vi.fn();
    const notify = vi.fn();
    const dispatch = vi.fn();
    const effects = createBrowserEffectService(
      { toast, notify, dispatch, notificationPermission: () => 'denied' },
      log.service,
    );
    effects.emit({ type: 'toast', level: 'success', message: 'done' });
    effects.emit({ type: 'application-event', name: 'thread:done', detail: { id: '1' } });
    effects.emit({ type: 'notification', title: 'Done' });
    expect(toast).toHaveBeenCalledWith('success', 'done');
    expect(dispatch).toHaveBeenCalledWith('thread:done', { id: '1' });
    expect(notify).not.toHaveBeenCalled();
    expect(log.values.at(-1)?.optional).toBe(true);
  });

  test('adapts fetch responses/failures and validates composition before use', async () => {
    const log = diagnostics();
    const transport = createBrowserTransportService(
      resolveWebEnvironment({ isTauri: false, pageOrigin: 'https://funny.test' }),
      vi.fn(async () => new Response('ok', { status: 200, headers: { 'x-test': 'yes' } })),
      log.service,
    );
    const response = await transport.request({ url: '/api/profile' });
    expect(response.status).toBe(200);
    expect(response.headers['x-test']).toBe('yes');
    expect(await response.text()).toBe('ok');
    expect(() => createClientComposition({} as never)).toThrow(/missing capabilities/);
  });

  test('keeps browser connectivity listeners at the web edge and disposes them', () => {
    const listeners = new Map<string, EventListener>();
    const win = {
      addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    } as unknown as Window;
    const recordFailure = vi.fn();
    const retryNow = vi.fn(async () => undefined);
    const store = {
      getState: () => ({ state: 'open', recordFailure, retryNow }),
    } as never;
    const dispose = installBrowserCircuitConnectivity(win, store);
    listeners.get('offline')?.(new Event('offline'));
    listeners.get('online')?.(new Event('online'));
    expect(recordFailure).toHaveBeenCalledOnce();
    expect(retryNow).toHaveBeenCalledOnce();
    dispose();
    expect(listeners.size).toBe(0);
  });
});
