import { describe, expect, test } from 'bun:test';

import {
  addReferencedEntries,
  parseReferencedFiles,
  serializeReferencedFiles,
  stripReferencedContents,
  type ReferencedEntry,
} from '../../attachments/referenced-files';

describe('referenced-files codec', () => {
  test('round-trips files, notes, contents and folders', () => {
    const entries: ReferencedEntry[] = [
      { type: 'file', path: 'a.md', content: '# A\n\nbody' },
      { type: 'file', path: 'b.pdf', note: 'Use the Read tool' },
      {
        type: 'folder',
        path: 'src',
        note: 'Showing 1 of 2 files.',
        children: [{ type: 'file', path: 'src/x.ts', content: 'x' }],
      },
      { type: 'folder', path: 'empty' },
    ];
    const text = serializeReferencedFiles(entries, 'hello');
    expect(parseReferencedFiles(text)).toEqual({ entries, body: 'hello' });
  });

  test('escapes and unescapes attribute values', () => {
    const entries: ReferencedEntry[] = [{ type: 'file', path: 'a"b&<c>.txt' }];
    const text = serializeReferencedFiles(entries, '');
    expect(text).toBe(
      '<referenced-files>\n<file path="a&quot;b&amp;&lt;c&gt;.txt" />\n</referenced-files>',
    );
    expect(parseReferencedFiles(text).entries).toEqual(entries);
  });

  test('returns the body unchanged when there are no entries', () => {
    expect(serializeReferencedFiles([], 'hi')).toBe('hi');
    expect(parseReferencedFiles('hi')).toEqual({ entries: [], body: 'hi' });
  });

  test('merges consecutive leading blocks', () => {
    const text =
      '<referenced-files>\n<file path="a.pdf" />\n</referenced-files>\n\n' +
      '<referenced-files>\n<file path="b.md">\n# B\n</file>\n</referenced-files>\n\nRead these';
    expect(parseReferencedFiles(text)).toEqual({
      entries: [
        { type: 'file', path: 'a.pdf' },
        { type: 'file', path: 'b.md', content: '# B' },
      ],
      body: 'Read these',
    });
  });

  test('inline contents containing </referenced-files> do not end the block', () => {
    const text =
      '<referenced-files>\n<file path="s.ts">\nconst x = `</referenced-files>`;\n</file>\n</referenced-files>\nprompt';
    expect(parseReferencedFiles(text)).toEqual({
      entries: [{ type: 'file', path: 's.ts', content: 'const x = `</referenced-files>`;' }],
      body: 'prompt',
    });
  });

  test('ignores blocks that are not at the start', () => {
    const text = 'intro\n<referenced-files>\n<file path="a.ts" />\n</referenced-files>';
    expect(parseReferencedFiles(text)).toEqual({ entries: [], body: text });
  });

  test('leaves an unterminated block untouched', () => {
    const text = '<referenced-files>\n<file path="a.ts" />\nno close';
    expect(parseReferencedFiles(text)).toEqual({ entries: [], body: text });
  });

  test('addReferencedEntries merges into the existing block instead of adding a second one', () => {
    const prompt = serializeReferencedFiles([{ type: 'file', path: 'a.md', content: 'A' }], 'go');
    const out = addReferencedEntries(prompt, [{ type: 'file', path: 'b.pdf', note: 'Binary' }]);
    expect(out.match(/<referenced-files>/g)).toHaveLength(1);
    expect(parseReferencedFiles(out).entries.map((e) => e.path)).toEqual(['a.md', 'b.pdf']);
    expect(parseReferencedFiles(out).body).toBe('go');
  });

  test('stripReferencedContents keeps paths and notes only', () => {
    const text = serializeReferencedFiles(
      [
        { type: 'file', path: 'a.md', content: 'secret' },
        {
          type: 'folder',
          path: 'src',
          children: [{ type: 'file', path: 'src/x.ts', content: 'x' }],
        },
      ],
      'go',
    );
    expect(stripReferencedContents(text)).toBe(
      '<referenced-files>\n<file path="a.md" />\n<folder path="src"></folder>\n</referenced-files>\n\ngo',
    );
  });
});
