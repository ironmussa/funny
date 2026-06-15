import { describe, expect, test } from 'vitest';

import { isExternalUrl, resolveImageSrc, toRawFileSrc } from '@/lib/raw-file-src';

describe('raw-file-src', () => {
  test('isExternalUrl recognizes web and inline URLs', () => {
    expect(isExternalUrl('http://example.com/a.png')).toBe(true);
    expect(isExternalUrl('https://example.com/a.png')).toBe(true);
    expect(isExternalUrl('//cdn.example.com/a.png')).toBe(true);
    expect(isExternalUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isExternalUrl('blob:http://localhost/abc')).toBe(true);
  });

  test('isExternalUrl treats filesystem paths as non-external', () => {
    expect(isExternalUrl('/home/user/out.png')).toBe(false);
    expect(isExternalUrl('./screenshot.png')).toBe(false);
    expect(isExternalUrl('out.png')).toBe(false);
  });

  test('toRawFileSrc routes a path through /api/files/raw, encoded', () => {
    expect(toRawFileSrc('/home/u/my file.png')).toBe(
      '/api/files/raw?path=%2Fhome%2Fu%2Fmy%20file.png',
    );
  });

  test('resolveImageSrc passes external URLs through, rewrites local paths', () => {
    expect(resolveImageSrc('https://x.com/a.png')).toBe('https://x.com/a.png');
    expect(resolveImageSrc('/abs/out.png')).toBe('/api/files/raw?path=%2Fabs%2Fout.png');
    expect(resolveImageSrc(undefined)).toBeUndefined();
    expect(resolveImageSrc('')).toBeUndefined();
  });
});
