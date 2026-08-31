import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveNativeAppDataDirectory } from '../platform/app-data';
import { NativeDiagnosticService, type SafeClientDiagnostic } from '../platform/diagnostics';
import { FileNativeSessionStore, MemoryNativeSessionStore } from '../platform/session-store';
import { NativeKeyValueStorage } from '../platform/storage';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'funny-gpuix-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('native application data', () => {
  test('resolves the conventional directory for each published host family', () => {
    expect(
      resolveNativeAppDataDirectory({ platform: 'linux', environment: { HOME: '/users/alice' } }),
    ).toBe('/users/alice/.local/share/funny/gpuix');
    expect(
      resolveNativeAppDataDirectory({
        platform: 'darwin',
        environment: { HOME: '/Users/alice' },
      }),
    ).toBe('/Users/alice/Library/Application Support/funny/gpuix');
    expect(
      resolveNativeAppDataDirectory({
        platform: 'win32',
        environment: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
      }),
    ).toBe('C:\\Users\\alice\\AppData\\Local\\funny\\gpuix');
  });

  test('rejects unresolved and relative roots', () => {
    expect(() => resolveNativeAppDataDirectory({ platform: 'freebsd', environment: {} })).toThrow(
      'Unable to resolve',
    );
    expect(() =>
      resolveNativeAppDataDirectory({ platform: 'linux', environment: { HOME: 'relative' } }),
    ).toThrow('absolute');
  });
});

describe('native persistence', () => {
  test('atomically persists values and notifies subscribers', () => {
    const directory = temporaryDirectory();
    const diagnostics: SafeClientDiagnostic[] = [];
    const service = new NativeKeyValueStorage(
      join(directory, 'preferences.json'),
      new NativeDiagnosticService((diagnostic) => diagnostics.push(diagnostic)),
    );
    const changes: unknown[] = [];
    const unsubscribe = service.subscribe((change) => changes.push(change));
    service.write('theme', 'dark');
    service.remove('theme');
    unsubscribe();
    service.write('theme', 'light');
    expect(changes).toEqual([
      { key: 'theme', value: 'dark' },
      { key: 'theme', value: null },
    ]);
    expect(
      new NativeKeyValueStorage(
        join(directory, 'preferences.json'),
        new NativeDiagnosticService(() => undefined),
      ).read('theme'),
    ).toBe('light');
    expect(diagnostics).toEqual([]);
  });

  test('recovers malformed storage and redacts diagnostic secrets', () => {
    const directory = temporaryDirectory();
    const file = join(directory, 'preferences.json');
    writeFileSync(file, '[]');
    const diagnostics: SafeClientDiagnostic[] = [];
    const diagnosticService = new NativeDiagnosticService((value) => diagnostics.push(value));
    const service = new NativeKeyValueStorage(file, diagnosticService);
    expect(service.read('theme')).toBeNull();
    diagnosticService.report({
      capability: 'transport',
      operation: 'request',
      error: new Error('authorization=secret token=also-secret'),
    });
    expect(diagnostics[1]?.error.message).toBe('authorization=[redacted] token=[redacted]');
  });

  test('continues in memory and diagnoses an unavailable persistence path', () => {
    const directory = temporaryDirectory();
    const blockingFile = join(directory, 'not-a-directory');
    writeFileSync(blockingFile, 'blocked');
    const diagnostics: SafeClientDiagnostic[] = [];
    const service = new NativeKeyValueStorage(
      join(blockingFile, 'preferences.json'),
      new NativeDiagnosticService((diagnostic) => diagnostics.push(diagnostic)),
    );
    service.write('theme', 'dark');
    expect(service.read('theme')).toBe('dark');
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.at(-1)).toMatchObject({ capability: 'storage', operation: 'write' });
  });

  test('persists only bounded session material with user-only permissions', () => {
    const directory = temporaryDirectory();
    const file = join(directory, 'session.json');
    const store = new FileNativeSessionStore(file, new NativeDiagnosticService(() => undefined));
    store.save({ cookieHeader: 'funny.session=value' });
    expect(store.load()).toEqual({ cookieHeader: 'funny.session=value' });
    expect(readFileSync(file, 'utf8')).not.toContain('password');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    store.clear();
    expect(store.load()).toBeNull();
  });

  test('supports an explicitly non-persistent session', () => {
    const store = new MemoryNativeSessionStore();
    store.save({ cookieHeader: 'session=memory' });
    expect(store.load()).toEqual({ cookieHeader: 'session=memory' });
    store.clear();
    expect(store.load()).toBeNull();
  });
});
