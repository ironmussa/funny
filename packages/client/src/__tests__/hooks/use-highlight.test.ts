import { describe, test, expect } from 'vitest';

import { detectLanguageFromContent } from '@/hooks/use-highlight';

/**
 * Regression: Cursor's ACP `read` tool calls omit the file path, so the Read
 * card has no extension to infer a language from and used to render plaintext
 * (no syntax highlighting). detectLanguageFromContent recovers the language
 * from the content itself for these path-less reads.
 */
describe('detectLanguageFromContent', () => {
  test('detects TypeScript from code content', async () => {
    const code = `import type { ThreadStatus } from '@funny/shared';
import { describe, test, expect, vi } from 'vitest';

describe('StatusBadge', () => {
  const statuses: ThreadStatus[] = ['idle', 'pending', 'running'];
  test('renders', () => {
    expect(statuses.length).toBeGreaterThan(0);
  });
});`;
    expect(await detectLanguageFromContent(code)).toBe('typescript');
  });

  test('detects Python from code content', async () => {
    const code = `import os

def greet(name):
    return f"hi {name}"

print(greet(os.getcwd()))`;
    expect(await detectLanguageFromContent(code)).toBe('python');
  });

  test('falls back to plaintext for prose (low relevance)', async () => {
    const prose = 'hello this is just plain prose\nwith two lines and nothing code-like';
    expect(await detectLanguageFromContent(prose)).toBe('plaintext');
  });

  test('falls back to plaintext for empty content', async () => {
    expect(await detectLanguageFromContent('   \n  ')).toBe('plaintext');
  });
});
