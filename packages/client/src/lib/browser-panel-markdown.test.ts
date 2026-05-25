import { describe, expect, it } from 'vitest';

import type { Annotation } from '@/stores/browser-panel-store';

import {
  annotationsToMarkdown,
  annotationsToTitle,
  extractImageAttachments,
} from './browser-panel-markdown';

const pin = (over: Partial<Extract<Annotation, { kind: 'pin' }>> = {}): Annotation => ({
  id: 'p1',
  kind: 'pin',
  x: 100,
  y: 200,
  note: '',
  ...over,
});

const region = (over: Partial<Extract<Annotation, { kind: 'region' }>> = {}): Annotation => ({
  id: 'r1',
  kind: 'region',
  x: 10,
  y: 20,
  w: 100,
  h: 50,
  note: '',
  ...over,
});

const draw = (over: Partial<Extract<Annotation, { kind: 'draw' }>> = {}): Annotation => ({
  id: 'd1',
  kind: 'draw',
  color: '#ef4444',
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  note: '',
  ...over,
});

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

describe('annotationsToMarkdown', () => {
  it('pin-only with note renders coords and note', () => {
    const md = annotationsToMarkdown('http://localhost:5173', [
      pin({ x: 123, y: 456, note: 'broken button' }),
    ]);
    expect(md).toContain('# Annotated URL: http://localhost:5173');
    expect(md).toContain('## Annotation 1 — pin @ (123, 456)');
    expect(md).toContain('broken button');
  });

  it('region-only renders coords with × separator', () => {
    const md = annotationsToMarkdown('http://x.test', [
      region({ x: 5, y: 10, w: 200, h: 80, note: 'wrong layout here' }),
    ]);
    expect(md).toContain('## Annotation 1 — region @ (5, 10, 200×80)');
    expect(md).toContain('wrong layout here');
  });

  it('draw-only renders color name and attached-image line when dataUrl present', () => {
    const md = annotationsToMarkdown('http://x.test', [
      draw({ color: '#3b82f6', dataUrl: PNG_DATA_URL, note: 'circled the bad icon' }),
    ]);
    expect(md).toContain('## Annotation 1 — draw (blue)');
    expect(md).toContain('circled the bad icon');
    expect(md).toContain('(see attached image)');
  });

  it('mixed annotations are numbered 1..N in order', () => {
    const md = annotationsToMarkdown('http://x.test', [
      pin({ note: 'A' }),
      region({ note: 'B' }),
      draw({ note: 'C', dataUrl: PNG_DATA_URL }),
    ]);
    expect(md).toMatch(/## Annotation 1 — pin/);
    expect(md).toMatch(/## Annotation 2 — region/);
    expect(md).toMatch(/## Annotation 3 — draw/);
    const order = md.indexOf('A') < md.indexOf('B') && md.indexOf('B') < md.indexOf('C');
    expect(order).toBe(true);
  });

  it('empty-note pin omits the note body but keeps the heading', () => {
    const md = annotationsToMarkdown('http://x.test', [pin({ note: '' })]);
    expect(md).toContain('## Annotation 1 — pin @ (100, 200)');
    // Heading is the last non-empty line; no body paragraph follows.
    const lines = md.split('\n').filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toBe('## Annotation 1 — pin @ (100, 200)');
  });

  it('whitespace-only notes are treated as empty', () => {
    const md = annotationsToMarkdown('http://x.test', [pin({ note: '   \n  \t  ' })]);
    expect(md).not.toMatch(/\n {3}|\t/);
  });

  it('draw with empty dataUrl skips the attached-image line', () => {
    const md = annotationsToMarkdown('http://x.test', [
      draw({ dataUrl: '', color: '#22c55e', note: 'no strokes yet' }),
    ]);
    expect(md).not.toContain('(see attached image)');
    expect(md).toContain('## Annotation 1 — draw (green)');
  });

  it('truncates very long URLs in the markdown title', () => {
    const longUrl = 'http://example.test/' + 'a'.repeat(500);
    const md = annotationsToMarkdown(longUrl, [pin()]);
    const firstLine = md.split('\n', 1)[0];
    expect(firstLine.length).toBeLessThanOrEqual('# Annotated URL: '.length + 200);
    expect(firstLine.endsWith('…')).toBe(true);
  });

  it('pin with dom info surfaces selector/testid/component in markdown', () => {
    const md = annotationsToMarkdown('http://localhost:5173', [
      pin({
        note: 'broken',
        dom: {
          selector: 'button.cta-primary',
          tagName: 'BUTTON',
          testid: 'signup-btn',
          text: 'Sign up',
          classes: ['cta-primary'],
          componentName: 'SignUpButton',
          boundingBox: { x: 100, y: 100, w: 120, h: 44 },
          computedStyles: {},
          accessibility: {},
        },
      }),
    ]);
    expect(md).toContain('### Element');
    expect(md).toContain('selector: `button.cta-primary`');
    expect(md).toContain('data-testid: `signup-btn`');
    expect(md).toContain('component: `SignUpButton`');
    expect(md).toContain('text: "Sign up"');
  });

  it('region with elements lists candidate selectors', () => {
    const md = annotationsToMarkdown('http://localhost:5173', [
      region({
        note: 'this card',
        dom: {
          rect: { x: 10, y: 20, w: 200, h: 80 },
          elements: [
            {
              selector: '.card',
              tagName: 'DIV',
              testid: 'product-card',
              classes: ['card'],
              boundingBox: { x: 10, y: 20, w: 200, h: 80 },
              computedStyles: {},
              accessibility: {},
            },
            {
              selector: '.card .price',
              tagName: 'SPAN',
              classes: ['price'],
              componentName: 'PriceTag',
              boundingBox: { x: 30, y: 60, w: 50, h: 20 },
              computedStyles: {},
              accessibility: {},
            },
          ],
        },
      }),
    ]);
    expect(md).toContain('### Candidate elements');
    expect(md).toContain('`.card`');
    expect(md).toContain('data-testid="product-card"');
    expect(md).toContain('`.card .price`');
    expect(md).toContain('— PriceTag');
  });

  it('legacy annotations (no dom field) still render without an Element section', () => {
    const md = annotationsToMarkdown('http://x.test', [pin({ note: 'old-style pin from iframe' })]);
    expect(md).toContain('## Annotation 1 — pin');
    expect(md).not.toContain('### Element');
  });
});

describe('annotationsToTitle', () => {
  it('formats short URLs as-is', () => {
    expect(annotationsToTitle('http://localhost:5173')).toBe('Annotated: http://localhost:5173');
  });

  it('truncates titles to 80 chars with an ellipsis', () => {
    const longUrl = 'http://example.test/' + 'a'.repeat(200);
    const title = annotationsToTitle(longUrl);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps the "Annotated: " prefix even when truncated', () => {
    const longUrl = 'http://example.test/' + 'a'.repeat(200);
    expect(annotationsToTitle(longUrl).startsWith('Annotated: ')).toBe(true);
  });
});

describe('extractImageAttachments', () => {
  it('returns one attachment per non-empty draw annotation', () => {
    const out = extractImageAttachments([
      pin({ note: 'ignored' }),
      draw({ dataUrl: PNG_DATA_URL, color: '#ef4444' }),
      draw({ dataUrl: 'data:image/jpeg;base64,/9j/AAA=', color: '#3b82f6' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    });
    expect(out[1].source.media_type).toBe('image/jpeg');
  });

  it('skips draw entries with empty dataUrl', () => {
    const out = extractImageAttachments([draw({ dataUrl: '' })]);
    expect(out).toEqual([]);
  });

  it('skips draw entries with malformed dataUrl', () => {
    const out = extractImageAttachments([
      draw({ dataUrl: 'not-a-data-url' }),
      draw({ dataUrl: 'data:text/plain;base64,aGVsbG8=' }),
    ]);
    expect(out).toEqual([]);
  });

  it('returns empty array when there are no draw annotations', () => {
    const out = extractImageAttachments([pin(), region()]);
    expect(out).toEqual([]);
  });
});
