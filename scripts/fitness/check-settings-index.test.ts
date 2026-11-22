import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  CLIENT_SRC,
  checkSettingsIndex,
  PRIMITIVES_FILE,
  readIndexIds,
  scanFile,
  unrenderedIds,
} from './check-settings-index';

const INDEX = "const ENTRIES = [\n  {\n    id: 'a.one',\n  },\n  {\n    id: 'a.two',\n  },\n];";
const PAGE = `${CLIENT_SRC}/components/Page.tsx`;

describe('fitness:settings-index', () => {
  test('reads the ids of the index, and refuses a duplicate', () => {
    expect(readIndexIds(INDEX)).toEqual({ ids: ['a.one', 'a.two'], violations: [] });
    const dup = readIndexIds(`${INDEX}\n  {\n    id: 'a.one',\n  },`);
    expect(dup.violations.some((v) => v.includes('duplicate id `a.one`'))).toBe(true);
  });

  test('finds rendered ids and reports the ones nobody renders', () => {
    const scanned = scanFile(PAGE, '<SettingRow settingId="a.one" title="x" />');
    expect(scanned).toEqual({ rendered: ['a.one'], violations: [] });
    const orphan = unrenderedIds(['a.one', 'a.two'], new Set(scanned.rendered));
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toContain('`a.two`');
  });

  test('only the SettingsSection primitive may use the section header class', () => {
    const header = scanFile(PAGE, 'const a = 1;\n<h3 className="settings-section-header">X</h3>');
    expect(header.violations[0]).toStartWith(`${PAGE}:2:`);
    expect(scanFile(PRIMITIVES_FILE, "cn('settings-section-header')").violations).toEqual([]);
  });

  test('the repository settings index is in sync with the rendered settings', () => {
    const result = checkSettingsIndex(join(import.meta.dir, '..', '..'));
    expect(result.violations).toEqual([]);
    expect(result.ids).toBeGreaterThan(0);
  });
});
