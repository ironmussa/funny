import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateClientPlatform,
  type ClientCancellation,
  type SemanticEffect,
} from '@funny/client-core';

import { createNativeClientComposition } from '../platform/composition';
import { NativeDiagnosticService, type SafeClientDiagnostic } from '../platform/diagnostics';
import { NativeEffectService } from '../platform/effects';
import { NATIVE_HOST_FOCUS_EVIDENCE, NativeLifecycleService } from '../platform/lifecycle';
import { NativeNavigationService } from '../platform/navigation';
import { MemoryNativeSessionStore } from '../platform/session-store';
import {
  NativeCookieJar,
  NativeTransportService,
  type NativeFetch,
  type NativeHeaders,
} from '../platform/transport';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'funny-gpuix-platform-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class TestHeaders implements NativeHeaders {
  constructor(
    private readonly values: Record<string, string> = {},
    private readonly cookies: string[] = [],
  ) {}

  get(name: string): string | null {
    return this.values[name.toLowerCase()] ?? null;
  }

  getSetCookie(): string[] {
    return this.cookies;
  }

  forEach(callback: (value: string, key: string) => void): void {
    for (const [key, value] of Object.entries(this.values)) callback(value, key);
  }
}

describe('native navigation and lifecycle', () => {
  test('notifies only meaningful navigation and lifecycle changes and disposes listeners', () => {
    const navigation = new NativeNavigationService();
    const lifecycle = new NativeLifecycleService();
    const locations: string[] = [];
    const snapshots: boolean[] = [];
    const stopNavigation = navigation.subscribe((location) => locations.push(location.pathname));
    const stopLifecycle = lifecycle.subscribe((snapshot) => snapshots.push(snapshot.focused));
    navigation.navigate({ pathname: '/', search: '', hash: '' });
    navigation.navigate({ pathname: '/thread/t1', search: '', hash: '' });
    lifecycle.update({ focused: true });
    lifecycle.update({ focused: false });
    stopNavigation();
    stopLifecycle();
    navigation.navigate({
      pathname: '/projects/p1/threads/t2',
      search: '',
      hash: '',
    });
    lifecycle.update({ focused: true });
    expect(locations).toEqual(['/thread/t1']);
    expect(snapshots).toEqual([false]);
    expect(navigation.route()).toMatchObject({
      projectId: 'p1',
      threadId: 't2',
    });
  });

  test('publishes an inactive snapshot only at the verified window termination boundary', () => {
    const lifecycle = new NativeLifecycleService();
    const snapshots: Array<{ focused: boolean; visible: boolean }> = [];
    lifecycle.subscribe((snapshot) => snapshots.push(snapshot));

    expect(lifecycle.current()).toEqual({ focused: true, visible: true });
    expect(NATIVE_HOST_FOCUS_EVIDENCE).toEqual({
      supported: false,
      runtime: 'GPUIX 0.5.1',
      reason: 'independent host-focus signal unavailable',
    });

    lifecycle.markWindowTerminated();
    lifecycle.markWindowTerminated();

    expect(lifecycle.current()).toEqual({ focused: false, visible: false });
    expect(snapshots).toEqual([{ focused: false, visible: false }]);
  });
});

describe('native effects', () => {
  test('presents supported effects and diagnoses unsupported effects without changing state', () => {
    const diagnostics: SafeClientDiagnostic[] = [];
    const presented: SemanticEffect[] = [];
    const service = new NativeEffectService(
      { toast: (effect) => presented.push(effect) },
      new NativeDiagnosticService((diagnostic) => diagnostics.push(diagnostic)),
    );
    service.emit({ type: 'toast', level: 'success', message: 'Saved' });
    service.emit({ type: 'notification', title: 'Done' });
    expect(presented).toEqual([{ type: 'toast', level: 'success', message: 'Saved' }]);
    expect(diagnostics[0]).toMatchObject({
      capability: 'effects',
      operation: 'unsupported.notification',
      optional: true,
    });
  });
});

describe('native authenticated transport', () => {
  test('captures and sends session cookies and rejects non-allowlisted origins', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    let call = 0;
    const fetch: NativeFetch = async (url, init) => {
      requests.push({ url, headers: init.headers });
      call += 1;
      return {
        status: 200,
        ok: true,
        headers: new TestHeaders({}, call === 1 ? ['funny.session=abc; Path=/; HttpOnly'] : []),
        text: async () => '{}',
      };
    };
    const diagnostics = new NativeDiagnosticService(() => undefined);
    const cookies = new NativeCookieJar(new MemoryNativeSessionStore(), diagnostics);
    const transport = new NativeTransportService({
      serverOrigin: 'http://localhost:5002',
      localServerPort: 5002,
      remoteOriginAllowlist: ['https://allowed.test'],
      fetch,
      cookies,
    });
    await transport.request({ url: '/api/auth/session' });
    await transport.request({ url: '/api/profile' });
    expect(requests[1]?.headers.Cookie).toBe('funny.session=abc');
    expect(transport.environment.hostMode).toBe('native');
    await expect(transport.request({ url: 'https://blocked.test/api/thread' })).rejects.toThrow(
      'rejected remote origin',
    );
    await expect(
      transport.request({ url: 'https://allowed.test/api/thread' }),
    ).resolves.toMatchObject({ ok: true });
  });

  test('bridges renderer-neutral cancellation to the native request', async () => {
    let abort: (() => void) | undefined;
    const cancellation: ClientCancellation = {
      aborted: false,
      subscribe(listener) {
        abort = listener;
        return () => {
          abort = undefined;
        };
      },
    };
    const fetch: NativeFetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    const transport = new NativeTransportService({
      serverOrigin: 'http://localhost:5002',
      localServerPort: 5002,
      remoteOriginAllowlist: [],
      fetch,
      cookies: new NativeCookieJar(
        new MemoryNativeSessionStore(),
        new NativeDiagnosticService(() => undefined),
      ),
    });
    const request = transport.request({ url: '/api/projects', cancellation });
    abort?.();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(abort).toBeUndefined();
  });

  test('aborts every in-flight request and rejects new work after disposal', async () => {
    let aborted = false;
    const transport = new NativeTransportService({
      serverOrigin: 'http://localhost:5002',
      localServerPort: 5002,
      remoteOriginAllowlist: [],
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
      cookies: new NativeCookieJar(
        new MemoryNativeSessionStore(),
        new NativeDiagnosticService(() => undefined),
      ),
    });
    const pending = transport.request({ url: '/api/projects' });
    transport.dispose();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
    await expect(transport.request({ url: '/api/projects' })).rejects.toThrow('disposed');
  });
});

describe('native platform composition', () => {
  test('validates every capability before renderer startup', () => {
    const diagnostics: SafeClientDiagnostic[] = [];
    const composition = createNativeClientComposition({
      dataDirectory: temporaryDirectory(),
      persistentSession: false,
      diagnosticSink: (diagnostic) => diagnostics.push(diagnostic),
      fetch: async () => ({
        status: 200,
        ok: true,
        headers: new TestHeaders(),
        text: async () => '{}',
      }),
    });
    expect(composition.platform.transport.environment.hostMode).toBe('native');
    expect(composition.platform.navigation).toBe(composition.navigation);
    expect(composition.platform.lifecycle).toBe(composition.lifecycle);
    expect(diagnostics).toEqual([]);
    expect(() => validateClientPlatform({ ...composition.platform, effects: undefined })).toThrow(
      'effects',
    );
  });
});
