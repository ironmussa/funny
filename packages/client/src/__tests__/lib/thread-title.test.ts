import { describe, test, expect } from 'vitest';

import { cleanThreadTitle } from '@/lib/thread-title';

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
