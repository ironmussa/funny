import { describe, test, expect } from 'vitest';

import {
  cleanThreadTitle,
  parseLeadingPromptCommand,
  parseLeadingSlashCommand,
  parseLinearIssueReference,
  parseThreadTitleForDisplay,
} from '@/lib/thread-title';

describe('cleanThreadTitle', () => {
  test('strips a leading <referenced-files> block', () => {
    const title =
      '<referenced-files>\n<file path="price_shoes_contactos_operaciones.csv">\nNombre,Cargo\nA,B\n</file>\n</referenced-files>\n\nque hay en este archivo';
    const { displayTitle, attachedFiles } = cleanThreadTitle(title);
    expect(displayTitle).toBe('que hay en este archivo');
    expect(attachedFiles.map((f) => f.path)).toEqual(['price_shoes_contactos_operaciones.csv']);
  });

  test('uses file names when the prompt text is empty', () => {
    const title =
      '<referenced-files>\n<file path="foo.txt">\nhello\n</file>\n<file path="bar/baz.csv">\nx\n</file>\n</referenced-files>';
    const { displayTitle, attachedFiles } = cleanThreadTitle(title);
    expect(displayTitle).toBe('foo.txt, baz.csv');
    expect(attachedFiles).toHaveLength(2);
  });

  test('sanitizes a truncated XML block so raw tags are never shown', () => {
    const title =
      '<referenced-files>\n<file path="price_shoes_contactos_operaciones.csv">\nNombre,Cargo\nA,B';
    const { displayTitle } = cleanThreadTitle(title);
    expect(displayTitle).not.toContain('<referenced-files>');
    expect(displayTitle).not.toContain('<file');
    expect(displayTitle).toContain('Nombre');
  });

  test('returns the title unchanged when no block is present', () => {
    const { displayTitle, attachedFiles } = cleanThreadTitle('Hello world');
    expect(displayTitle).toBe('Hello world');
    expect(attachedFiles).toEqual([]);
  });
});

describe('parseLeadingSlashCommand', () => {
  test('extracts a command that is the entire title', () => {
    expect(parseLeadingSlashCommand('/security-audit')).toEqual({
      command: 'security-audit',
      rest: '',
    });
  });

  test('extracts a command and the trailing text', () => {
    expect(parseLeadingSlashCommand('/security-audit check the auth layer')).toEqual({
      command: 'security-audit',
      rest: 'check the auth layer',
    });
  });

  test('supports namespaced commands', () => {
    expect(parseLeadingSlashCommand('/skill-creator:skill-creator make a thing')).toEqual({
      command: 'skill-creator:skill-creator',
      rest: 'make a thing',
    });
  });

  test('does not treat a file path as a command', () => {
    expect(parseLeadingSlashCommand('/home/user/file.ts is broken')).toEqual({
      command: null,
      rest: '/home/user/file.ts is broken',
    });
  });

  test('returns no command for plain prose', () => {
    expect(parseLeadingSlashCommand('fix the bug')).toEqual({
      command: null,
      rest: 'fix the bug',
    });
  });

  test('only matches a slash at the very start', () => {
    expect(parseLeadingSlashCommand('please run /security-audit')).toEqual({
      command: null,
      rest: 'please run /security-audit',
    });
  });
});

describe('parseLeadingPromptCommand', () => {
  test('extracts a leading slash command', () => {
    expect(parseLeadingPromptCommand('/security-audit check the auth layer')).toEqual({
      kind: 'slash',
      command: 'security-audit',
      rest: 'check the auth layer',
    });
  });

  test('extracts a leading exclamation command line', () => {
    expect(parseLeadingPromptCommand('! bun test --filter auth')).toEqual({
      kind: 'shell',
      command: 'bun test --filter auth',
      rest: '',
    });
  });

  test('supports exclamation commands without a separating space', () => {
    expect(parseLeadingPromptCommand('!npm run build')).toEqual({
      kind: 'shell',
      command: 'npm run build',
      rest: '',
    });
  });

  test('does not treat punctuation-only exclamation as a command', () => {
    expect(parseLeadingPromptCommand('!')).toEqual({
      kind: null,
      command: null,
      rest: '!',
    });
  });
});

describe('parseLinearIssueReference', () => {
  test('extracts a Linear issue URL and hides it from the display title', () => {
    expect(
      parseLinearIssueReference(
        'fix https://linear.app/goliiive-v3/issue/GOL-728/core-catalogo-publico-con today',
      ),
    ).toEqual({
      issueKey: 'GOL-728',
      url: 'https://linear.app/goliiive-v3/issue/GOL-728/core-catalogo-publico-con',
      displayTitle: 'fix today',
    });
  });

  test('trims trailing punctuation from the URL', () => {
    expect(
      parseLinearIssueReference('https://linear.app/goliiive-v3/issue/gol-773/example.'),
    ).toEqual({
      issueKey: 'GOL-773',
      url: 'https://linear.app/goliiive-v3/issue/gol-773/example',
      displayTitle: '',
    });
  });

  test('ignores non-Linear URLs', () => {
    expect(parseLinearIssueReference('https://example.com/goliiive-v3/issue/GOL-773/example')).toBe(
      null,
    );
  });
});

describe('parseThreadTitleForDisplay', () => {
  test('normalizes attachments, leading commands, and Linear issue references in one pass', () => {
    const parsed = parseThreadTitleForDisplay(
      '<referenced-files>\n<file path="src/a.ts" />\n</referenced-files>\n/fix-linear https://linear.app/goliiive-v3/issue/GOL-733/example revisar',
    );

    expect(parsed.attachedFiles.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(parsed.leadingCommand).toEqual({
      kind: 'slash',
      command: 'fix-linear',
      rest: 'https://linear.app/goliiive-v3/issue/GOL-733/example revisar',
    });
    expect(parsed.linearIssue?.issueKey).toBe('GOL-733');
    expect(parsed.visibleText).toBe('revisar');
  });
});
