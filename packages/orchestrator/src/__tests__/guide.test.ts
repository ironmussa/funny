/**
 * The issue factory guide (`docs/guides/issue-factory.md`) stays true to the
 * factory settings: its example parses with the schema, and its reference
 * table lists exactly the schema's fields.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { factorySettingsSchema } from '../settings/schema.js';

const guide = readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', 'docs', 'guides', 'issue-factory.md'),
  'utf8',
);

/** The block right after a `<!-- name -->` marker. */
function after(marker: string, opening: string, closing: string): string {
  const at = guide.indexOf(`<!-- ${marker} -->`);
  expect(at).toBeGreaterThan(-1);
  const start = guide.indexOf(opening, at) + opening.length;
  return guide.slice(start, guide.indexOf(closing, start));
}

/** Dotted paths of the leaves of a zod schema (`projects[].repo`, …). */
function leaves(schema: z.ZodType, prefix = ''): string[] {
  let current: any = schema;
  for (;;) {
    if (current.def?.type === 'array') {
      current = current.element;
      prefix = `${prefix}[]`;
    } else if (typeof current.unwrap === 'function') {
      current = current.unwrap();
    } else if (current.def?.type === 'pipe') {
      current = current.def.in;
    } else break;
  }
  if (current.def?.type !== 'object') return [prefix];
  return Object.entries(current.shape as Record<string, z.ZodType>).flatMap(([key, value]) =>
    leaves(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe('the issue factory guide', () => {
  test('its example is valid factory settings', () => {
    const example = parseYaml(after('factory-settings-example', '```yaml\n', '```'));
    const parsed = factorySettingsSchema.safeParse(example);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  test('its reference lists exactly the fields of the schema', () => {
    const table = after('factory-settings-reference', '| Field', '\n\n');
    const documented = [...table.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]).sort();
    expect(documented).toEqual(leaves(factorySettingsSchema).sort());
  });
});
