/**
 * Mustache interpolation tests.
 *
 * Validates basic substitution, dot-path access, sections, inverted
 * sections, recursive object interpolation, and strict-mode errors.
 */

import { describe, expect, test } from 'bun:test';

import {
  interpolate,
  interpolateObject,
  TemplateInterpolationError,
} from '../../yaml/interpolate.js';

describe('interpolate', () => {
  test('substitutes a simple variable', () => {
    expect(interpolate('Hello {{name}}', { name: 'Argenis' })).toBe('Hello Argenis');
  });

  test('does not HTML-escape — special chars pass through', () => {
    expect(interpolate('{{x}}', { x: '<script>alert(1)</script>' })).toBe(
      '<script>alert(1)</script>',
    );
  });

  test('supports dot-path access', () => {
    expect(
      interpolate('{{review.output.verdict}}', {
        review: { output: { verdict: 'pass' } },
      }),
    ).toBe('pass');
  });

  test('renders missing variables as empty string by default', () => {
    expect(interpolate('hi {{absent}}', {})).toBe('hi ');
  });

  test('strict mode throws on missing variables', () => {
    expect(() => interpolate('hi {{absent}}', {}, { strict: true })).toThrow(
      TemplateInterpolationError,
    );
  });

  test('strict mode allows variables that resolve to falsy values', () => {
    expect(interpolate('count={{count}}', { count: 0 }, { strict: true })).toBe('count=0');
  });

  test('iterates over arrays via {{#section}}', () => {
    const tpl = '{{#findings}}- {{description}}\n{{/findings}}';
    const result = interpolate(tpl, {
      findings: [{ description: 'a' }, { description: 'b' }],
    });
    expect(result).toBe('- a\n- b\n');
  });

  test('renders inverted section when value is empty/falsy', () => {
    const tpl = '{{^findings}}clean{{/findings}}';
    expect(interpolate(tpl, { findings: [] })).toBe('clean');
    expect(interpolate(tpl, { findings: false })).toBe('clean');
    expect(interpolate(tpl, {})).toBe('clean');
  });

  test('renders empty-string for empty templates', () => {
    expect(interpolate('', { x: 1 })).toBe('');
  });
});

describe('interpolateObject', () => {
  test('renders strings recursively, leaves primitives as-is', () => {
    const out = interpolateObject(
      { msg: 'Hi {{name}}', count: 5, ok: true, nested: { greet: 'hola {{name}}' } },
      { name: 'A' },
    );
    expect(out).toEqual({
      msg: 'Hi A',
      count: 5,
      ok: true,
      nested: { greet: 'hola A' },
    });
  });

  test('handles arrays of strings', () => {
    const out = interpolateObject(['{{a}}', '{{b}}', 'lit'], { a: '1', b: '2' });
    expect(out).toEqual(['1', '2', 'lit']);
  });

  test('preserves null and undefined', () => {
    expect(interpolateObject(null, {})).toBeNull();
    expect(interpolateObject(undefined, {})).toBeUndefined();
  });

  test('preserves array structure when nested', () => {
    const out = interpolateObject({ items: [{ k: '{{x}}' }, { k: 'lit' }] }, { x: 'foo' });
    expect(out).toEqual({ items: [{ k: 'foo' }, { k: 'lit' }] });
  });
});
