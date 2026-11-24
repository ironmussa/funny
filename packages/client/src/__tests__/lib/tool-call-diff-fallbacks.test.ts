import { describe, expect, test } from 'bun:test';

import type { FileDiffSummary } from '@funny/shared';

import { buildToolCallDiffFallbacks } from '@/lib/tool-call-diff-fallbacks';

function file(path: string): FileDiffSummary {
  return { path, status: 'modified', staged: false };
}

describe('buildToolCallDiffFallbacks', () => {
  test('builds a per-file fallback diff from edit tool calls in a session', () => {
    const diffs = buildToolCallDiffFallbacks(
      [
        {
          type: 'toolcall',
          tc: {
            name: 'Edit',
            input: JSON.stringify({
              file_path: '/repo/index.ts',
              old_string: 'const value = 1;\n',
              new_string: 'const value = 2;\n',
            }),
          },
        },
      ],
      [file('index.ts')],
    );

    expect(diffs.get('index.ts')).toContain('-const value = 1;');
    expect(diffs.get('index.ts')).toContain('+const value = 2;');
  });

  test('builds the diff of every MultiEdit edit and skips edits that are not text', () => {
    const diffs = buildToolCallDiffFallbacks(
      [
        {
          type: 'toolcall',
          tc: {
            name: 'MultiEdit',
            input: {
              file_path: '/repo/index.ts',
              edits: [
                { old_string: 'const a = 1;\n', new_string: 'const a = 2;\n' },
                { old_string: 'unchanged\n', new_string: 'unchanged\n' },
                { old_string: 3, new_string: 'ignored\n' },
                null,
                { old_string: 'const b = 1;\n', new_string: 'const b = 2;\n' },
              ],
            },
          },
        },
      ],
      [file('index.ts')],
    );

    const diff = diffs.get('index.ts') ?? '';
    expect(diff).toContain('-const a = 1;');
    expect(diff).toContain('+const b = 2;');
    expect(diff).not.toContain('ignored');
    expect(diff).not.toContain('unchanged');
  });

  test('shows a Write as the whole file added', () => {
    const diffs = buildToolCallDiffFallbacks(
      [
        {
          type: 'toolcall',
          tc: { name: 'Write', input: { file_path: '/repo/new.ts', content: 'export {};\n' } },
        },
      ],
      [file('new.ts')],
    );

    expect(diffs.get('new.ts')).toContain('+export {};');
  });
});
