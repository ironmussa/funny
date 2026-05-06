/**
 * Tests for env/index.ts — combined env detection across resolvers.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { delimiter, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { detectEnv } from '../env/index.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const TMP = resolve(__dir, '__tmp_detect_env_test__');

const IS_WINDOWS = process.platform === 'win32';
const VENV_BIN = IS_WINDOWS ? 'Scripts' : 'bin';
const PYTHON_BIN = IS_WINDOWS ? 'python.exe' : 'python';
const NODE_BIN = IS_WINDOWS ? 'node.exe' : 'node';

function makeVenv(cwd: string): string {
  const venvPath = resolve(cwd, '.venv');
  const binPath = resolve(venvPath, VENV_BIN);
  mkdirSync(binPath, { recursive: true });
  const py = resolve(binPath, PYTHON_BIN);
  writeFileSync(py, '#!/bin/sh\n');
  if (!IS_WINDOWS) chmodSync(py, 0o755);
  return binPath;
}

function makeNodeInstall(home: string, version: string): string {
  const binDir = resolve(home, '.nvm/versions/node', `v${version}`, 'bin');
  mkdirSync(binDir, { recursive: true });
  const nodePath = resolve(binDir, NODE_BIN);
  writeFileSync(nodePath, '#!/bin/sh\n');
  if (!IS_WINDOWS) chmodSync(nodePath, 0o755);
  return binDir;
}

describe('detectEnv', () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = resolve(TMP, 'project');
    home = resolve(TMP, 'home');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('returns empty mutations when nothing is detected', () => {
    const result = detectEnv(cwd, { HOME: home });
    expect(result.notes).toEqual([]);
    expect(Object.keys(result.env)).toHaveLength(0);
  });

  test('reports only python when only venv exists', () => {
    makeVenv(cwd);
    const result = detectEnv(cwd, { HOME: home, PATH: '/usr/bin' });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].kind).toBe('python-venv');
    expect(result.env.VIRTUAL_ENV).toContain('.venv');
  });

  test('reports only node when only .nvmrc resolves', () => {
    writeFileSync(resolve(cwd, '.nvmrc'), '20.11.0\n');
    const nodeBin = makeNodeInstall(home, '20.11.0');

    const result = detectEnv(cwd, { HOME: home, PATH: '/usr/bin' });
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].kind).toBe('node-version');
    expect(result.env.PATH).toBe(`${nodeBin}${delimiter}/usr/bin`);
  });

  test('stacks PATH prepends from both resolvers without clobbering', () => {
    const venvBin = makeVenv(cwd);
    writeFileSync(resolve(cwd, '.nvmrc'), '20.11.0\n');
    const nodeBin = makeNodeInstall(home, '20.11.0');

    const result = detectEnv(cwd, { HOME: home, PATH: '/usr/bin' });

    expect(result.notes).toHaveLength(2);
    // venv runs after node, so venv bin should come first, then node, then original PATH
    expect(result.env.PATH).toBe(`${venvBin}${delimiter}${nodeBin}${delimiter}/usr/bin`);
    expect(result.env.VIRTUAL_ENV).toBeDefined();
  });
});
