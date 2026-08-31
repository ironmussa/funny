import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNativeApplicationServices } from '../application';
import { createNativeClientComposition } from '../platform/composition';
import type { SafeClientDiagnostic } from '../platform/diagnostics';
import type { NativeHeaders } from '../platform/transport';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class HeadersStub implements NativeHeaders {
  get(): string | null {
    return null;
  }
  forEach(): void {}
}

describe('native application recovery', () => {
  test('presents a retryable startup error with redacted diagnostics, then recovers anonymous', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funny-native-recovery-'));
    directories.push(directory);
    const diagnostics: SafeClientDiagnostic[] = [];
    const methods: string[] = [];
    let online = false;
    const composition = createNativeClientComposition({
      dataDirectory: directory,
      persistentSession: false,
      diagnosticSink: (diagnostic) => diagnostics.push(diagnostic),
      fetch: async (_url, init) => {
        methods.push(init.method);
        if (!online) throw new Error('server unavailable token=abc password=secret');
        return {
          status: 200,
          ok: true,
          headers: new HeadersStub(),
          text: async () => 'null',
        };
      },
    });
    const application = createNativeApplicationServices(composition);
    expect(await application.start()).toBeNull();
    expect(application.statusState.getState().phase).toBe('error');
    expect(JSON.stringify(diagnostics)).not.toContain('abc');
    expect(JSON.stringify(diagnostics)).not.toContain('secret');
    online = true;
    expect(await application.retry()).toBe(false);
    expect(application.statusState.getState().phase).toBe('ready');
    expect(application.authState.getState().phase).toBe('anonymous');
    expect(methods.every((method) => method === 'GET')).toBe(true);
    application.dispose();
  });
});
