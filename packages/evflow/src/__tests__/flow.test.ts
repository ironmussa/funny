import { describe, test, expect } from 'bun:test';

import { parseFlow, parseStringSequence } from '../flow.js';
import type { ElementRef, ElementKind } from '../types.js';

function ref(name: string, kind: ElementKind = 'command'): ElementRef {
  return { name, kind, toString: () => name };
}

describe('parseFlow (tagged template literal)', () => {
  test('parses a two-element flow', () => {
    const a = ref('AddItem', 'command');
    const b = ref('ItemAdded', 'event');
    // Simulate: flow`${a} -> ${b}`
    const strings = Object.assign(['', ' -> ', ''], {
      raw: ['', ' -> ', ''],
    }) as TemplateStringsArray;
    const result = parseFlow(strings, [a, b]);
    expect(result).toEqual([
      { name: 'AddItem', kind: 'command' },
      { name: 'ItemAdded', kind: 'event' },
    ]);
  });

  test('parses a multi-element flow', () => {
    const a = ref('A', 'command');
    const b = ref('B', 'event');
    const c = ref('C', 'readModel');
    const strings = Object.assign(['', ' -> ', ' -> ', ''], {
      raw: ['', ' -> ', ' -> ', ''],
    }) as TemplateStringsArray;
    const result = parseFlow(strings, [a, b, c]);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ name: 'C', kind: 'readModel' });
  });

  test('handles whitespace around elements', () => {
    const a = ref('A', 'command');
    const b = ref('B', 'event');
    const strings = Object.assign(['\n  ', ' -> ', '  \n'], {
      raw: ['\n  ', ' -> ', '  \n'],
    }) as TemplateStringsArray;
    const result = parseFlow(strings, [a, b]);
    expect(result).toHaveLength(2);
  });

  test('handles single element without arrows', () => {
    const a = ref('OnlyOne', 'command');
    const strings = Object.assign(['', ''], { raw: ['', ''] }) as TemplateStringsArray;
    const result = parseFlow(strings, [a]);
    expect(result).toEqual([{ name: 'OnlyOne', kind: 'command' }]);
  });

  test('returns empty for no elements', () => {
    const strings = Object.assign([''], { raw: [''] }) as TemplateStringsArray;
    const result = parseFlow(strings, []);
    expect(result).toEqual([]);
  });

  test('throws on text between elements instead of arrow', () => {
    const a = ref('A', 'command');
    const b = ref('B', 'event');
    const strings = Object.assign(['', ' then ', ''], {
      raw: ['', ' then ', ''],
    }) as TemplateStringsArray;
    expect(() => parseFlow(strings, [a, b])).toThrow('expected "->"');
  });

  test('throws on non-ElementRef values', () => {
    const strings = Object.assign(['', ' -> ', ''], {
      raw: ['', ' -> ', ''],
    }) as TemplateStringsArray;
    expect(() => parseFlow(strings, ['hello' as any, 42 as any])).toThrow('ElementRef');
  });
});

describe('parseStringSequence', () => {
  test('parses "A -> B -> C"', () => {
    expect(parseStringSequence('A -> B -> C')).toEqual(['A', 'B', 'C']);
  });

  test('handles extra whitespace', () => {
    expect(parseStringSequence('  A  ->  B  ->  C  ')).toEqual(['A', 'B', 'C']);
  });

  test('handles single element', () => {
    expect(parseStringSequence('OnlyOne')).toEqual(['OnlyOne']);
  });

  test('handles empty string', () => {
    expect(parseStringSequence('')).toEqual([]);
  });

  test('handles multiline input', () => {
    const input = `
      AddItem -> ItemAdded
      -> StartCheckout -> CheckoutStarted
    `;
    const result = parseStringSequence(input);
    expect(result).toEqual(['AddItem', 'ItemAdded', 'StartCheckout', 'CheckoutStarted']);
  });
});
