import { describe, test, expect } from 'bun:test';

import { isTextualContentType } from '../runner-protocol.js';

describe('isTextualContentType', () => {
  test('treats a missing content-type as textual (legacy back-compat)', () => {
    expect(isTextualContentType(undefined)).toBe(true);
    expect(isTextualContentType(null)).toBe(true);
    expect(isTextualContentType('')).toBe(true);
  });

  test('recognizes text/* as textual', () => {
    expect(isTextualContentType('text/plain; charset=utf-8')).toBe(true);
    expect(isTextualContentType('text/html')).toBe(true);
    expect(isTextualContentType('text/markdown; charset=utf-8')).toBe(true);
    expect(isTextualContentType('text/csv')).toBe(true);
  });

  test('recognizes JSON / XML / JS / YAML families as textual', () => {
    expect(isTextualContentType('application/json')).toBe(true);
    expect(isTextualContentType('application/json; charset=utf-8')).toBe(true);
    expect(isTextualContentType('application/ld+json')).toBe(true);
    expect(isTextualContentType('application/vnd.api+json')).toBe(true);
    expect(isTextualContentType('application/x-ndjson')).toBe(true);
    expect(isTextualContentType('application/xml')).toBe(true);
    expect(isTextualContentType('application/atom+xml')).toBe(true);
    expect(isTextualContentType('image/svg+xml')).toBe(true);
    expect(isTextualContentType('application/javascript')).toBe(true);
    expect(isTextualContentType('application/yaml')).toBe(true);
  });

  test('treats binary media as NON-textual (must be base64-encoded)', () => {
    expect(isTextualContentType('image/png')).toBe(false);
    expect(isTextualContentType('image/jpeg')).toBe(false);
    expect(isTextualContentType('image/gif')).toBe(false);
    expect(isTextualContentType('image/webp')).toBe(false);
    expect(isTextualContentType('video/mp4')).toBe(false);
    expect(isTextualContentType('audio/mpeg')).toBe(false);
    expect(isTextualContentType('application/pdf')).toBe(false);
    expect(isTextualContentType('application/octet-stream')).toBe(false);
    expect(isTextualContentType('font/woff2')).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isTextualContentType('Application/JSON')).toBe(true);
    expect(isTextualContentType('IMAGE/PNG')).toBe(false);
  });
});
