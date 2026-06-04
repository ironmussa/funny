import { beforeEach, describe, expect, test, vi } from 'vitest';

import { loadInstalledVisualizers } from '@/lib/visualizer-loader';
import {
  __resetVisualizerRegistry,
  getVisualizerForFence,
  registerVisualizer,
  type VisualizerPlugin,
} from '@/lib/visualizer-registry';

const NOOP: VisualizerPlugin['Component'] = () => null;

function plugin(id: string, fences: string[]): VisualizerPlugin {
  return { id, version: '1.0.0', contributes: { fences }, Component: NOOP };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  __resetVisualizerRegistry();
});

describe('loadInstalledVisualizers', () => {
  test('fetches the manifest and registers each plugin via dynamic import', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse([
        { id: 'a', version: '1.0.0', entryUrl: '/extensions/a/index.mjs' },
        { id: 'b', version: '1.0.0', entryUrl: '/extensions/b/index.mjs' },
      ]),
    );
    const importFn = vi.fn(async (url: string) => ({
      default: url.includes('/a/') ? plugin('ext-a', ['aaa']) : plugin('ext-b', ['bbb']),
    }));

    await loadInstalledVisualizers(fetchFn as unknown as typeof fetch, importFn);

    expect(fetchFn).toHaveBeenCalledWith('/api/extensions');
    expect(getVisualizerForFence('aaa')?.id).toBe('ext-a');
    expect(getVisualizerForFence('bbb')?.id).toBe('ext-b');
  });

  test('a single broken plugin does not block the others', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse([
        { id: 'good', version: '1.0.0', entryUrl: '/extensions/good/index.mjs' },
        { id: 'throws', version: '1.0.0', entryUrl: '/extensions/throws/index.mjs' },
        { id: 'invalid', version: '1.0.0', entryUrl: '/extensions/invalid/index.mjs' },
      ]),
    );
    const importFn = vi.fn(async (url: string) => {
      if (url.includes('/throws/')) throw new Error('boom');
      if (url.includes('/invalid/')) return { default: { id: 'invalid', nope: true } };
      return { default: plugin('good', ['ok']) };
    });

    await loadInstalledVisualizers(fetchFn as unknown as typeof fetch, importFn);

    expect(getVisualizerForFence('ok')?.id).toBe('good');
  });

  test('a failed manifest fetch is swallowed (no throw, nothing registered)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(null, false, 500));
    const importFn = vi.fn();

    await expect(
      loadInstalledVisualizers(fetchFn as unknown as typeof fetch, importFn),
    ).resolves.toBeUndefined();
    expect(importFn).not.toHaveBeenCalled();
  });

  test('an installed plugin can override a built-in fence', async () => {
    registerVisualizer(plugin('@funny/visualizer-mermaid', ['mermaid']));
    const fetchFn = vi.fn(async () =>
      jsonResponse([{ id: 'x', version: '1.0.0', entryUrl: '/extensions/x/index.mjs' }]),
    );
    const importFn = vi.fn(async () => ({ default: plugin('third-party-mermaid', ['mermaid']) }));

    await loadInstalledVisualizers(fetchFn as unknown as typeof fetch, importFn);

    expect(getVisualizerForFence('mermaid')?.id).toBe('third-party-mermaid');
  });
});
