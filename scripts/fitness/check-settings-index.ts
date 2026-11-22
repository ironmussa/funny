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
 * Tests and stories are not scanned. Exits non-zero on violation; the
 * fixtures live in `check-settings-index.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { walkSources } from './walk-sources';

const ROOT = join(import.meta.dir, '..', '..');
export const CLIENT_SRC = 'packages/client/src';
export const INDEX_FILE = `${CLIENT_SRC}/components/settings/settings-index.ts`;
export const PRIMITIVES_FILE = `${CLIENT_SRC}/components/settings/SettingRow.tsx`;

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

/** Every problem of the settings index in the repository at `root`, and how many ids it has. */
export function checkSettingsIndex(root: string): { ids: number; violations: string[] } {
  const { ids, violations } = readIndexIds(readFileSync(join(root, INDEX_FILE), 'utf8'));
  const rendered = new Set<string>();
  for (const abs of walkSources(join(root, CLIENT_SRC), /\.(test|stories)\.tsx?$/)) {
    const file = relative(root, abs).split(sep).join('/');
    const scanned = scanFile(file, readFileSync(abs, 'utf8'));
    for (const id of scanned.rendered) rendered.add(id);
    violations.push(...scanned.violations);
  }
  if (ids.length === 0)
    violations.push(`${INDEX_FILE}: no ids found (did the entry format change?)`);
  violations.push(...unrenderedIds(ids, rendered));
  return { ids: ids.length, violations };
}

if (import.meta.main) {
  const { ids, violations } = checkSettingsIndex(ROOT);
  if (violations.length) {
    console.error(
      `settings index: ${violations.length} problem(s)\n  ${violations.join('\n  ')}\n` +
        'Keep settings-index.ts and the rendered settingId props in sync (openspec settings-filter).',
    );
    process.exit(1);
  }
  console.log(`settings index ok — ${ids} indexed settings, all rendered`);
}
