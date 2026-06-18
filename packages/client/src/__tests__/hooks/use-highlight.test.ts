import { describe, test, expect } from 'vitest';

import { detectLanguageFromContent, ensureLanguage, highlightCode } from '@/hooks/use-highlight';

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

/**
 * Regression: highlight.js's bash grammar does not tokenize common CLI snippets
 * like `uvx modal run ... --video ...`, which made bash cards look mostly
 * monochrome. The shell augmentation should add spans for commands, subcommands,
 * flags, paths, and env assignments.
 */
describe('highlightCode bash augmentation', () => {
  test('adds shell-specific tokens to CLI commands', async () => {
    await ensureLanguage('bash');

    const html = highlightCode(
      'uvx modal run scripts/modal_sam3_smoke.py --video video_source/clip.mp4',
      'bash',
    );

    expect(html).toContain('<span class="hljs-title function_">uvx</span>');
    expect(html).toContain('<span class="hljs-built_in">modal</span>');
    expect(html).toContain('<span class="hljs-built_in">run</span>');
    expect(html).toContain('<span class="hljs-string">scripts/modal_sam3_smoke.py</span>');
    expect(html).toContain('<span class="hljs-attr">--video</span>');
    expect(html).toContain('<span class="hljs-string">video_source/clip.mp4</span>');
  });

  test('highlights env assignments without consuming the command slot', async () => {
    await ensureLanguage('bash');

    const html = highlightCode('HF_TOKEN=hf_xxx uvx modal setup', 'bash');

    expect(html).toContain(
      '<span class="hljs-variable">HF_TOKEN</span>=<span class="hljs-string">hf_xxx</span>',
    );
    expect(html).toContain('<span class="hljs-title function_">uvx</span>');
    expect(html).toContain('<span class="hljs-built_in">modal</span>');
    expect(html).toContain('<span class="hljs-built_in">setup</span>');
  });
});
