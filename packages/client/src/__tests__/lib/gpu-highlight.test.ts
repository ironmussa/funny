import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('gpu-lexer', () => ({ parse }));

beforeEach(() => {
  vi.resetModules();
  parse.mockReset();
  vi.stubGlobal('navigator', { gpu: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('GPU highlighting', () => {
  it('escapes source and closes multiline spans for independent rows', async () => {
    const code = '/* <tag>\n& 😀 */';
    parse.mockResolvedValue([{ type: 'comment', start: 0, end: code.length }]);
    const { prepareGpuHighlight, getGpuHighlight } = await import('@/lib/gpu-highlight');
    expect(await prepareGpuHighlight(code)).toBe(true);
    expect(getGpuHighlight(code)).toBe(
      '<span class="hljs-comment">/* &lt;tag&gt;</span>\n<span class="hljs-comment">&amp; 😀 */</span>',
    );
    expect(getGpuHighlight('& 😀 */')).toBe('<span class="hljs-comment">&amp; 😀 */</span>');
  });

  it('preserves gaps and ignores unknown token classes', async () => {
    parse.mockResolvedValue([{ type: '"><img>', start: 2, end: 5 }]);
    const { prepareGpuHighlight, getGpuHighlight } = await import('@/lib/gpu-highlight');
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
    const { prepareGpuHighlight } = await import('@/lib/gpu-highlight');
    const first = prepareGpuHighlight('first');
    const duplicate = prepareGpuHighlight('first');
    const second = prepareGpuHighlight('second');
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(1));
    release([]);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('uses the grammar fallback when WebGPU is absent', async () => {
    vi.stubGlobal('navigator', {});
    const { ensureHighlight, highlightCode } = await import('@/hooks/use-highlight');
    expect(await ensureHighlight('const answer = 42;', 'javascript')).toBe(true);
    expect(highlightCode('const answer = 42;', 'javascript')).toContain('hljs-keyword');
    expect(parse).not.toHaveBeenCalled();
  });

  it('falls back after an adapter failure without retrying every block', async () => {
    parse.mockRejectedValue(new Error('WebGPU unavailable'));
    const { ensureHighlight, highlightCode } = await import('@/hooks/use-highlight');
    expect(await ensureHighlight('const a = 1;', 'javascript')).toBe(true);
    expect(await ensureHighlight('const b = 2;', 'javascript')).toBe(true);
    expect(highlightCode('const a = 1;', 'javascript')).toContain('hljs-keyword');
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid spans without caching corrupt source', async () => {
    parse.mockResolvedValue([{ type: 'string', start: 0, end: 999 }]);
    const { prepareGpuHighlight, getGpuHighlight } = await import('@/lib/gpu-highlight');
    expect(await prepareGpuHighlight('<script>')).toBe(false);
    expect(getGpuHighlight('<script>')).toBeUndefined();
  });

  it('uses GPU tokens for languages without a registered grammar', async () => {
    parse.mockResolvedValue([{ type: 'keyword', start: 0, end: 5 }]);
    const { ensureHighlight, highlightCode, highlightLine } = await import('@/hooks/use-highlight');
    expect(await ensureHighlight('const x', 'plaintext')).toBe(true);
    expect(highlightCode('const x', 'plaintext')).toBe('<span class="hljs-keyword">const</span> x');
    expect(highlightLine('const x', 'plaintext')).toBe(highlightCode('const x', 'plaintext'));
  });
});
