import { describe, expect, test, vi } from 'vitest';

describe('symbols extractor', () => {
  test('handles concurrent first-time TS extraction', async () => {
    vi.resetModules();
    const { extractSymbols } = await import('../symbols/index.js');

    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        extractSymbols(
          `export function extractConcurrent${index}() { return ${index}; }`,
          `src/concurrent-${index}.ts`,
        ),
      ),
    );

    const errors = results.filter((result) => result.isErr()).map((result) => result.error.message);
    expect(errors).toEqual([]);

    expect(
      results.map((result, index) => {
        if (result.isErr()) throw new Error(result.error.message);
        return result.value[0]?.name ?? `missing-${index}`;
      }),
    ).toEqual(Array.from({ length: 16 }, (_, index) => `extractConcurrent${index}`));
  });

  test('extracts exported and local symbols from TSX', async () => {
    const { extractSymbols } = await import('../symbols/index.js');

    const result = await extractSymbols(
      [
        'export function PromptEditor() {',
        '  return <div />;',
        '}',
        'const pendingCount = 1;',
        'export interface PromptEditorProps {',
        '  value: string;',
        '}',
      ].join('\n'),
      'src/PromptEditor.tsx',
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    expect(result.value.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: 'function', name: 'PromptEditor' },
      { kind: 'variable', name: 'pendingCount' },
      { kind: 'interface', name: 'PromptEditorProps' },
    ]);
  });
});
