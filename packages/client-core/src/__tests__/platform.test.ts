import { describe, expect, test } from 'bun:test';

import { InvalidClientPlatformError, validateClientPlatform } from '../platform';
import { createInMemoryPlatform } from '../testing/in-memory-platform';

describe('client platform', () => {
  test('reports every missing capability and method', () => {
    expect(() =>
      validateClientPlatform({
        storage: { read() {} },
        navigation: {},
        transport: { request() {} },
      }),
    ).toThrow(InvalidClientPlatformError);

    try {
      validateClientPlatform({
        storage: { read() {} },
        navigation: {},
        transport: { request() {} },
      });
    } catch (error) {
      expect((error as InvalidClientPlatformError).missing).toEqual([
        'storage.write',
        'storage.remove',
        'storage.subscribe',
        'navigation.current',
        'navigation.navigate',
        'navigation.subscribe',
        'lifecycle',
        'effects',
        'diagnostics',
        'transport.environment',
      ]);
    }
  });

  test('offers deterministic storage, location, lifecycle, effects, and diagnostics', () => {
    const host = createInMemoryPlatform({ storage: { theme: 'dark' } });
    const storageChanges: unknown[] = [];
    const locations: unknown[] = [];
    const lifecycle: unknown[] = [];
    const stopStorage = host.platform.storage.subscribe((change) => storageChanges.push(change));
    const stopLocation = host.platform.navigation.subscribe((value) => locations.push(value));
    const stopLifecycle = host.platform.lifecycle.subscribe((value) => lifecycle.push(value));

    host.platform.storage.write('theme', 'light');
    host.controls.setLocation({ pathname: '/threads/one' });
    host.controls.setLifecycle({ visible: false });
    host.platform.effects.emit({ type: 'toast', level: 'info', message: 'saved' });
    host.platform.diagnostics.report({ capability: 'storage', operation: 'read', error: 'denied' });

    expect(host.controls.storageSnapshot()).toEqual({ theme: 'light' });
    expect(storageChanges).toEqual([{ key: 'theme', value: 'light' }]);
    expect(locations).toEqual([{ pathname: '/threads/one', search: '', hash: '' }]);
    expect(lifecycle).toEqual([{ focused: true, visible: false }]);
    expect(host.controls.effects).toHaveLength(1);
    expect(host.controls.diagnostics).toHaveLength(1);

    stopStorage();
    stopLocation();
    stopLifecycle();
    host.controls.setStorage('theme', null);
    host.controls.setLocation({ pathname: '/' });
    host.controls.setLifecycle({ focused: false });
    expect(storageChanges).toHaveLength(1);
    expect(locations).toHaveLength(1);
    expect(lifecycle).toHaveLength(1);
  });
});
