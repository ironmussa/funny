import { describe, expect, test } from 'bun:test';

import { VISUALIZER_IMPORT_MAP, VISUALIZER_IMPORT_MAP_JSON } from '../visualizer-importmap.mjs';

describe('VISUALIZER_IMPORT_MAP', () => {
  test('maps the plugin SDK specifier and keeps the legacy host alias', () => {
    expect(VISUALIZER_IMPORT_MAP.imports['@funny/plugin-sdk']).toBe('/vendor/funny-plugin-sdk.mjs');
    expect(VISUALIZER_IMPORT_MAP.imports['@funny/host']).toBe('/vendor/funny-host.mjs');
  });

  test('exports canonical JSON that matches the import map object', () => {
    expect(VISUALIZER_IMPORT_MAP_JSON).toBe(JSON.stringify(VISUALIZER_IMPORT_MAP));
  });
});
