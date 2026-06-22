import type { FileDiffSummary } from '@funny/shared';
import { describe, expect, test } from 'vitest';

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
});
