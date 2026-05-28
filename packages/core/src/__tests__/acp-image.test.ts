/**
 * Tests for `toACPImageBlocks` — converts the two image shapes funny may pass
 * (Anthropic-style `{ source: { data, media_type } }` from the DB, and flat
 * ACP-style `{ data, mimeType }`) into ACP `ImageContent` blocks. Tolerant of
 * mixed/junk input so an upload pipeline glitch can't crash the prompt.
 */

import { describe, expect, test } from 'vitest';

import { toACPImageBlocks } from '../agents/acp-image.js';

describe('toACPImageBlocks', () => {
  test('undefined / non-array input → []', () => {
    expect(toACPImageBlocks(undefined)).toEqual([]);
    expect(toACPImageBlocks(null)).toEqual([]);
    expect(toACPImageBlocks('not-an-array')).toEqual([]);
    expect(toACPImageBlocks({})).toEqual([]);
  });

  test('empty array → []', () => {
    expect(toACPImageBlocks([])).toEqual([]);
  });

  test('Anthropic-shape input converts to ACP block', () => {
    const out = toACPImageBlocks([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ]);
    expect(out).toEqual([{ type: 'image', data: 'abc', mimeType: 'image/png' }]);
  });

  test('flat ACP-shape input is idempotent (passes through)', () => {
    const out = toACPImageBlocks([{ type: 'image', data: 'xyz', mimeType: 'image/jpeg' }]);
    expect(out).toEqual([{ type: 'image', data: 'xyz', mimeType: 'image/jpeg' }]);
  });

  test('mixed valid + invalid entries: drops invalid, keeps valid', () => {
    const out = toACPImageBlocks([
      { source: { data: 'a', media_type: 'image/png' } },
      { data: 'b' }, // missing mimeType
      { mimeType: 'image/jpeg' }, // missing data
      null,
      'string',
      { data: 'c', mimeType: 'image/webp' },
    ]);
    expect(out).toEqual([
      { type: 'image', data: 'a', mimeType: 'image/png' },
      { type: 'image', data: 'c', mimeType: 'image/webp' },
    ]);
  });

  test('Anthropic shape takes precedence over flat fields when both are present', () => {
    const out = toACPImageBlocks([
      {
        source: { data: 'from-source', media_type: 'image/png' },
        data: 'from-flat',
        mimeType: 'image/jpeg',
      },
    ]);
    expect(out).toEqual([{ type: 'image', data: 'from-source', mimeType: 'image/png' }]);
  });

  test('non-string data / mimeType are rejected', () => {
    const out = toACPImageBlocks([
      { data: 123 as unknown as string, mimeType: 'image/png' },
      { data: 'abc', mimeType: {} as unknown as string },
    ]);
    expect(out).toEqual([]);
  });
});
