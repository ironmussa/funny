/**
 * Tests for ports/config-reader.ts
 *
 * Tests reading .funny.json project configuration files.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';

import { readProjectConfig } from '../ports/config-reader.js';

const TMP = resolve(import.meta.dir, '__tmp_config_test__');

describe('config-reader', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('returns null when .funny.json does not exist', () => {
    const config = readProjectConfig(TMP);
    expect(config).toBeNull();
  });

  test('reads a valid .funny.json file', () => {
    const configData = {
      portGroups: [
        { name: 'api', basePort: 3000, envVars: ['API_PORT'] },
        { name: 'db', basePort: 5432, envVars: ['DB_PORT'] },
      ],
      envFiles: ['.env'],
      postCreate: ['npm install'],
    };

    writeFileSync(resolve(TMP, '.funny.json'), JSON.stringify(configData));

    const config = readProjectConfig(TMP);
    expect(config).not.toBeNull();
    expect(config!.portGroups).toHaveLength(2);
    expect(config!.portGroups![0].name).toBe('api');
    expect(config!.envFiles).toEqual(['.env']);
    expect(config!.postCreate).toEqual(['npm install']);
  });

  test('returns null for malformed JSON', () => {
    writeFileSync(resolve(TMP, '.funny.json'), '{ invalid json }');

    const config = readProjectConfig(TMP);
    expect(config).toBeNull();
  });

  test('reads config with minimal fields', () => {
    writeFileSync(resolve(TMP, '.funny.json'), JSON.stringify({}));

    const config = readProjectConfig(TMP);
    expect(config).not.toBeNull();
    expect(config).toEqual({});
  });

  test('reads config with only postCreate commands', () => {
    const configData = {
      postCreate: ['bun install', 'bun run build'],
    };

    writeFileSync(resolve(TMP, '.funny.json'), JSON.stringify(configData));

    const config = readProjectConfig(TMP);
    expect(config!.postCreate).toEqual(['bun install', 'bun run build']);
    expect(config!.portGroups).toBeUndefined();
  });
});
