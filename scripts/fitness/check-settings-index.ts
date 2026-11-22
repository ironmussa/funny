#!/usr/bin/env bun
/**
 * Fitness function: the settings index matches the rendered settings
 * (openspec `settings-filter`).
 *
 * The sidebar filter searches `packages/client/src/components/settings/
 * settings-index.ts`, because settings pages are not mounted while closed.
 * Typecheck already refuses a rendered `settingId` that is not in the index
 * (the prop is typed `SettingId`). This checks the other direction and the
 * shape around it:
 *
 * - every id in the index is unique, and is rendered somewhere as
 *   `settingId="<id>"` (an id nobody renders is a search result that opens a
 *   page and scrolls to nothing);
 * - the `settings-section-header` class is used only by the `SettingsSection`
 *   primitive, so a new section header cannot skip the index.
 *
 * Tests and stories are not scanned. Exits non-zero on violation;
 * `--self-test` checks the fixtures.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const CLIENT_SRC = 'packages/client/src';
const INDEX_FILE = `${CLIENT_SRC}/components/settings/settings-index.ts`;
const PRIMITIVES_FILE = `${CLIENT_SRC}/components/settings/SettingRow.tsx`;

const INDEX_ID = /^\s*id: '([^']+)',$/gm;
const RENDERED_ID = /settingId="([^"]+)"/g;
const SECTION_CLASS = /settings-section-header/g;

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** Ids declared in the index source, with duplicate violations. */
export function readIndexIds(source: string): { ids: string[]; violations: string[] } {
  const ids: string[] = [];
  const violations: string[] = [];
  for (const match of source.matchAll(INDEX_ID)) {
    const id = match[1]!;
    if (ids.includes(id)) {
      violations.push(`${INDEX_FILE}:${lineOf(source, match.index)}: duplicate id \`${id}\``);
    }
    ids.push(id);
  }
  return { ids, violations };
}

/** Rendered ids and shape violations for one client source file. */
export function scanFile(
  file: string,
  source: string,
): { rendered: string[]; violations: string[] } {
  const rendered = [...source.matchAll(RENDERED_ID)].map((m) => m[1]!);
  const violations: string[] = [];
  if (file !== PRIMITIVES_FILE) {
    for (const match of source.matchAll(SECTION_CLASS)) {
      violations.push(
        `${file}:${lineOf(source, match.index)}: \`settings-section-header\` outside SettingsSection — use <SettingsSection settingId=…>`,
      );
    }
  }
  return { rendered, violations };
}

/** Index ids that no file renders. */
export function unrenderedIds(ids: readonly string[], rendered: ReadonlySet<string>): string[] {
  return ids.flatMap((id) =>
    rendered.has(id)
      ? []
      : [`${INDEX_FILE}: \`${id}\` is indexed but never rendered as settingId="${id}"`],
  );
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|stories)\.tsx?$/.test(entry)) yield full;
  }
}

function runSelfTest(): void {
  const index = "const ENTRIES = [\n  {\n    id: 'a.one',\n  },\n  {\n    id: 'a.two',\n  },\n];";
  const { ids, violations: none } = readIndexIds(index);
  if (ids.join() !== 'a.one,a.two' || none.length) throw new Error(`self-test: read ${ids}`);
  const dup = readIndexIds(`${index}\n  {\n    id: 'a.one',\n  },`);
  if (!dup.violations.some((v) => v.includes('duplicate id `a.one`'))) {
    throw new Error('self-test: expected a duplicate violation');
  }

  const page = `${CLIENT_SRC}/components/Page.tsx`;
  const scanned = scanFile(page, '<SettingRow settingId="a.one" title="x" />');
  if (scanned.rendered.join() !== 'a.one' || scanned.violations.length) {
    throw new Error('self-test: expected a.one rendered and no violation');
  }
  const orphan = unrenderedIds(ids, new Set(scanned.rendered));
  if (orphan.length !== 1 || !orphan[0]!.includes('`a.two`')) {
    throw new Error(`self-test: expected a.two unrendered, got ${orphan.join()}`);
  }

  const header = scanFile(page, 'const a = 1;\n<h3 className="settings-section-header">X</h3>');
  if (!header.violations[0]?.startsWith(`${page}:2:`)) {
    throw new Error(`self-test: expected a header violation on line 2, got ${header.violations}`);
  }
  if (scanFile(PRIMITIVES_FILE, "cn('settings-section-header')").violations.length) {
    throw new Error('self-test: the primitive itself may use the class');
  }
  console.log('settings index self-test ok');
}

function main(): void {
  if (process.argv.includes('--self-test')) runSelfTest();
  const { ids, violations } = readIndexIds(readFileSync(join(ROOT, INDEX_FILE), 'utf8'));
  const rendered = new Set<string>();
  for (const abs of walk(join(ROOT, CLIENT_SRC))) {
    const file = relative(ROOT, abs).split(sep).join('/');
    const scanned = scanFile(file, readFileSync(abs, 'utf8'));
    for (const id of scanned.rendered) rendered.add(id);
    violations.push(...scanned.violations);
  }
  if (ids.length === 0)
    violations.push(`${INDEX_FILE}: no ids found (did the entry format change?)`);
  violations.push(...unrenderedIds(ids, rendered));
  if (violations.length) {
    console.error(
      `settings index: ${violations.length} problem(s)\n  ${violations.join('\n  ')}\n` +
        'Keep settings-index.ts and the rendered settingId props in sync (openspec settings-filter).',
    );
    process.exit(1);
  }
  console.log(`settings index ok — ${ids.length} indexed settings, all rendered`);
}

main();
