import { describe, test, expect } from 'bun:test';
import { LineBuffer, encodeNDJSON, decodeNDJSON } from '../../utils/ndjson-transport.js';

describe('LineBuffer', () => {
  test('returns complete lines from a single push', () => {
    const buf = new LineBuffer();
    const lines = buf.push('{"type":"hello"}\n');
    expect(lines).toEqual(['{"type":"hello"}']);
  });

  test('returns multiple complete lines from a single push', () => {
    const buf = new LineBuffer();
    const lines = buf.push('{"a":1}\n{"b":2}\n{"c":3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  test('buffers partial lines until completed', () => {
    const buf = new LineBuffer();

    const lines1 = buf.push('{"partial":');
    expect(lines1).toEqual([]);

    const lines2 = buf.push('"value"}\n');
    expect(lines2).toEqual(['{"partial":"value"}']);
  });

  test('handles chunks that split across multiple pushes', () => {
    const buf = new LineBuffer();

    expect(buf.push('{"a":')).toEqual([]);
    expect(buf.push('1}\n{"b":')).toEqual(['{"a":1}']);
    expect(buf.push('2}\n')).toEqual(['{"b":2}']);
  });

  test('filters out empty/whitespace-only lines', () => {
    const buf = new LineBuffer();
    const lines = buf.push('{"a":1}\n\n  \n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('flush returns remaining buffered data', () => {
    const buf = new LineBuffer();
    buf.push('{"incomplete":true');
    const flushed = buf.flush();
    expect(flushed).toBe('{"incomplete":true');
  });

  test('flush returns null when buffer is empty', () => {
    const buf = new LineBuffer();
    expect(buf.flush()).toBeNull();
  });

  test('flush returns null when buffer has only whitespace', () => {
    const buf = new LineBuffer();
    buf.push('{"a":1}\n');
    expect(buf.flush()).toBeNull();
  });

  test('flush clears the buffer', () => {
    const buf = new LineBuffer();
    buf.push('leftover');
    buf.flush();
    expect(buf.flush()).toBeNull();
  });

  // ── Edge cases ──────────────────────────────────────────────────

  test('handles unicode/emoji content', () => {
    const buf = new LineBuffer();
    const lines = buf.push('{"emoji":"🚀🔥","text":"日本語"}\n');
    expect(lines).toEqual(['{"emoji":"🚀🔥","text":"日本語"}']);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.emoji).toBe('🚀🔥');
    expect(parsed.text).toBe('日本語');
  });

  test('handles large payloads (>1MB)', () => {
    const buf = new LineBuffer();
    const bigStr = 'x'.repeat(1_500_000);
    const json = JSON.stringify({ data: bigStr });
    const lines = buf.push(json + '\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).data.length).toBe(1_500_000);
  });

  test('handles multiple consecutive newlines between messages', () => {
    const buf = new LineBuffer();
    const lines = buf.push('{"a":1}\n\n\n\n{"b":2}\n\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('handles carriage returns (\\r\\n)', () => {
    const buf = new LineBuffer();
    // \r will be part of the content since split is on \n
    const lines = buf.push('{"a":1}\r\n');
    // The \r should remain in the line content but trimming handles it
    expect(lines.length).toBeGreaterThan(0);
  });

  test('handles many sequential small pushes', () => {
    const buf = new LineBuffer();
    const chars = '{"key":"value"}\n';
    let result: string[] = [];
    for (const ch of chars) {
      result = result.concat(buf.push(ch));
    }
    expect(result).toEqual(['{"key":"value"}']);
  });

  test('handles push with only newlines', () => {
    const buf = new LineBuffer();
    const lines = buf.push('\n\n\n');
    expect(lines).toEqual([]);
  });
});

describe('encodeNDJSON', () => {
  test('serializes object with trailing newline', () => {
    expect(encodeNDJSON({ type: 'test' })).toBe('{"type":"test"}\n');
  });

  test('serializes string', () => {
    expect(encodeNDJSON('hello')).toBe('"hello"\n');
  });

  test('serializes number', () => {
    expect(encodeNDJSON(42)).toBe('42\n');
  });

  test('serializes null', () => {
    expect(encodeNDJSON(null)).toBe('null\n');
  });

  test('serializes nested object', () => {
    const obj = { a: { b: [1, 2, 3] } };
    expect(encodeNDJSON(obj)).toBe('{"a":{"b":[1,2,3]}}\n');
  });
});

describe('decodeNDJSON', () => {
  test('parses a JSON line', () => {
    expect(decodeNDJSON('{"type":"test"}')).toEqual({ type: 'test' });
  });

  test('parses a string', () => {
    expect(decodeNDJSON('"hello"')).toBe('hello');
  });

  test('parses a number', () => {
    expect(decodeNDJSON('42')).toBe(42);
  });

  test('throws on invalid JSON', () => {
    expect(() => decodeNDJSON('not json')).toThrow();
  });

  test('throws on empty string', () => {
    expect(() => decodeNDJSON('')).toThrow();
  });

  test('handles unicode content', () => {
    const result = decodeNDJSON('{"emoji":"🎉","jp":"東京"}');
    expect(result).toEqual({ emoji: '🎉', jp: '東京' });
  });

  test('handles deeply nested objects', () => {
    const deep = { a: { b: { c: { d: { e: 'deep' } } } } };
    const result = decodeNDJSON(JSON.stringify(deep));
    expect(result).toEqual(deep);
  });

  test('handles JSON with escaped characters', () => {
    const result = decodeNDJSON('{"text":"line1\\nline2\\ttab"}');
    expect((result as any).text).toBe('line1\nline2\ttab');
  });
});
