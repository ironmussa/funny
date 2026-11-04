import { describe, expect, test } from 'bun:test';

import { attachmentTextHint, classifyAttachment, looksLikeText } from '../../attachments/classify';

const limits = {
  inlineMaxBytes: 100 * 1024,
  uploadMaxBytes: 25 * 1024 * 1024,
  hardMaxBytes: 30 * 1024 * 1024,
};
const KB = 1024;

describe('classifyAttachment', () => {
  test('rejects files over the upload cap, whatever their type', () => {
    expect(
      classifyAttachment({ name: 'a.png', type: 'image/png', size: 26 * KB * KB }, limits),
    ).toBe('reject');
  });

  test('model-supported images become image blocks', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      expect(classifyAttachment({ name: 'x', type, size: KB }, limits)).toBe('image');
    }
  });

  test('images the model cannot take are uploaded', () => {
    expect(classifyAttachment({ name: 'a.heic', type: 'image/heic', size: KB }, limits)).toBe(
      'upload',
    );
    expect(classifyAttachment({ name: 'a.bmp', type: 'image/bmp', size: KB }, limits)).toBe(
      'upload',
    );
  });

  test('small text files are inlined', () => {
    expect(classifyAttachment({ name: 'a.md', type: 'text/markdown', size: KB }, limits)).toBe(
      'inline-text',
    );
    // Browsers report .ts as video/mp2t — the extension wins.
    expect(classifyAttachment({ name: 'a.ts', type: 'video/mp2t', size: KB }, limits)).toBe(
      'inline-text',
    );
    expect(classifyAttachment({ name: 'logo.svg', type: 'image/svg+xml', size: KB }, limits)).toBe(
      'inline-text',
    );
  });

  test('small binaries are uploaded, never inlined', () => {
    expect(
      classifyAttachment({ name: 'a.pdf', type: 'application/pdf', size: 10 * KB }, limits),
    ).toBe('upload');
    expect(classifyAttachment({ name: 'a.docx', type: '', size: 10 * KB }, limits)).toBe('upload');
  });

  test('large text files are uploaded', () => {
    expect(classifyAttachment({ name: 'a.csv', type: 'text/csv', size: 200 * KB }, limits)).toBe(
      'upload',
    );
  });

  test('unknown types follow the content sniff', () => {
    const meta = { name: 'LICENSE-NOTES', type: '', size: KB };
    expect(classifyAttachment({ ...meta, isText: true }, limits)).toBe('inline-text');
    expect(classifyAttachment({ ...meta, isText: false }, limits)).toBe('upload');
    expect(classifyAttachment(meta, limits)).toBe('upload');
  });
});

describe('attachmentTextHint', () => {
  test('matches extension-less well-known names', () => {
    expect(attachmentTextHint({ name: 'Dockerfile', type: '' })).toBe('text');
  });
  test('returns unknown for octet-stream without a known extension', () => {
    expect(attachmentTextHint({ name: 'blob', type: 'application/octet-stream' })).toBe('unknown');
  });
});

describe('looksLikeText', () => {
  test('accepts UTF-8 text, including a multi-byte char cut at the end', () => {
    const bytes = new TextEncoder().encode('hola ñandú');
    expect(looksLikeText(bytes)).toBe(true);
    expect(looksLikeText(bytes.subarray(0, bytes.length - 1))).toBe(true);
  });
  test('rejects NUL bytes and invalid UTF-8', () => {
    expect(looksLikeText(new Uint8Array([0x25, 0x50, 0x00, 0x46]))).toBe(false);
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false);
  });
});
