import { afterEach, beforeEach, describe, expect, it, mock, vi } from 'bun:test';

import { stubGlobal, unstubAllGlobals, waitFor } from '@funny/test-kit';

const { parse } = (() => ({ parse: vi.fn() }))();
vi.mock('gpu-lexer', () => ({ parse }));

// vitest used vi.resetModules() for fresh module state per test. bun has no
// module reset: load fresh instances with a query string instead, and point
// `@/lib/gpu-highlight` at the fresh one so a fresh `use-highlight` uses it.
let fresh = 0;

async function loadGpuHighlight(): Promise<typeof import('@/lib/gpu-highlight')> {
  fresh += 1;
  const gpu = (await import(
    `@/lib/gpu-highlight?fresh=${fresh}`
  )) as typeof import('@/lib/gpu-highlight');
  mock.module('@/lib/gpu-highlight', () => gpu);
  return gpu;
}

async function loadUseHighlight(): Promise<typeof import('@/hooks/use-highlight')> {
  await loadGpuHighlight();
  return (await import(
    `@/hooks/use-highlight?fresh=${fresh}`
  )) as typeof import('@/hooks/use-highlight');
}

beforeEach(() => {
  parse.mockReset();
  stubGlobal('navigator', { gpu: {} });
});
afterEach(() => unstubAllGlobals());

describe('GPU highlighting', () => {
  it('escapes source and closes multiline spans for independent rows', async () => {
    const code = '/* <tag>\n& 😀 */';
    parse.mockResolvedValue([{ type: 'comment', start: 0, end: code.length }]);
    const { prepareGpuHighlight, getGpuHighlight } = await loadGpuHighlight();
    expect(await prepareGpuHighlight(code)).toBe(true);
    expect(getGpuHighlight(code)).toBe(
      '<span class="hljs-comment">/* &lt;tag&gt;</span>\n<span class="hljs-comment">&amp; 😀 */</span>',
    );
    expect(getGpuHighlight('& 😀 */')).toBe('<span class="hljs-comment">&amp; 😀 */</span>');
  });

  it('preserves gaps and ignores unknown token classes', async () => {
    parse.mockResolvedValue([{ type: '"><img>', start: 2, end: 5 }]);
    const { prepareGpuHighlight, getGpuHighlight } = await loadGpuHighlight();
    await prepareGpuHighlight('a <b> c');
    expect(getGpuHighlight('a <b> c')).toBe('a &lt;b&gt; c');
  });

  it('deduplicates requests and serializes inference', async () => {
    let release!: (spans: unknown[]) => void;
    parse
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue([]);
    const { prepareGpuHighlight } = await loadGpuHighlight();
    const first = prepareGpuHighlight('first');
    const duplicate = prepareGpuHighlight('first');
    const second = prepareGpuHighlight('second');
    expect(duplicate).toBe(first);
    await waitFor(() => expect(parse).toHaveBeenCalledTimes(1));
    release([]);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('uses the grammar fallback when WebGPU is absent', async () => {
    stubGlobal('navigator', {});
    const { ensureHighlight, highlightCode } = await loadUseHighlight();
    expect(await ensureHighlight('const answer = 42;', 'javascript')).toBe(true);
    expect(highlightCode('const answer = 42;', 'javascript')).toContain('hljs-keyword');
    expect(parse).not.toHaveBeenCalled();
  });

  it('falls back after an adapter failure without retrying every block', async () => {
    parse.mockRejectedValue(new Error('WebGPU unavailable'));
    const { ensureHighlight, highlightCode } = await loadUseHighlight();
    expect(await ensureHighlight('const a = 1;', 'javascript')).toBe(true);
    expect(await ensureHighlight('const b = 2;', 'javascript')).toBe(true);
    expect(highlightCode('const a = 1;', 'javascript')).toContain('hljs-keyword');
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid spans without caching corrupt source', async () => {
    parse.mockResolvedValue([{ type: 'string', start: 0, end: 999 }]);
    const { prepareGpuHighlight, getGpuHighlight } = await loadGpuHighlight();
    expect(await prepareGpuHighlight('<script>')).toBe(false);
    expect(getGpuHighlight('<script>')).toBeUndefined();
  });

  it('uses GPU tokens for languages without a registered grammar', async () => {
    parse.mockResolvedValue([{ type: 'keyword', start: 0, end: 5 }]);
    const { ensureHighlight, highlightCode, highlightLine } = await loadUseHighlight();
    expect(await ensureHighlight('const x', 'plaintext')).toBe(true);
    expect(highlightCode('const x', 'plaintext')).toBe('<span class="hljs-keyword">const</span> x');
    expect(highlightLine('const x', 'plaintext')).toBe(highlightCode('const x', 'plaintext'));
  });
});
