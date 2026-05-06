/**
 * Tests for env/nvmrc.ts — Node version detection and bin path resolution.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { delimiter, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { resolveNodeVersion } from '../env/nvmrc.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const TMP = resolve(__dir, '__tmp_nvmrc_test__');

const IS_WINDOWS = process.platform === 'win32';
const NODE_BIN = IS_WINDOWS ? 'node.exe' : 'node';

function makeNvmInstall(home: string, version: string): string {
  const binDir = resolve(home, '.nvm/versions/node', `v${version}`, 'bin');
  mkdirSync(binDir, { recursive: true });
  const nodePath = resolve(binDir, NODE_BIN);
  writeFileSync(nodePath, '#!/bin/sh\n');
  if (!IS_WINDOWS) chmodSync(nodePath, 0o755);
  return binDir;
}

function makeFnmInstall(home: string, version: string): string {
  const binDir = resolve(home, '.fnm/node-versions', `v${version}`, 'installation/bin');
  mkdirSync(binDir, { recursive: true });
  const nodePath = resolve(binDir, NODE_BIN);
  writeFileSync(nodePath, '#!/bin/sh\n');
  if (!IS_WINDOWS) chmodSync(nodePath, 0o755);
  return binDir;
}

describe('resolveNodeVersion', () => {
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

  test('returns null when no .nvmrc exists', () => {
    expect(resolveNodeVersion(cwd, { HOME: home })).toBeNull();
  });

  test('returns null when .nvmrc is empty', () => {
    writeFileSync(resolve(cwd, '.nvmrc'), '');
    expect(resolveNodeVersion(cwd, { HOME: home })).toBeNull();
  });

  test('returns null for unsupported aliases', () => {
    writeFileSync(resolve(cwd, '.nvmrc'), 'lts/iron\n');
    makeNvmInstall(home, '20.11.0');
    expect(resolveNodeVersion(cwd, { HOME: home })).toBeNull();
  });

  test('returns null when version is pinned but not installed', () => {
    writeFileSync(resolve(cwd, '.nvmrc'), '20.11.0\n');
    expect(resolveNodeVersion(cwd, { HOME: home })).toBeNull();
  });

  test('detects nvm install with bare version', () => {
    writeFileSync(resolve(cwd, '.nvmrc'), '20.11.0\n');
    const binDir = makeNvmInstall(home, '20.11.0');

    const result = resolveNodeVersion(cwd, { HOME: home, PATH: '/usr/bin' });

    expect(result).not.toBeNull();
    expect(result!.version).toBe('20.11.0');
    expect(result!.binPath).toBe(binDir);
    expect(result!.env.PATH).toBe(`${binDir}${delimiter}/usr/bin`);
  });

  test('accepts v-prefixed version in .nvmrc', () => {
    writeFileSync(resolve(cwd, '.nvmrc'), 'v20.11.0\n');
    const binDir = makeNvmInstall(home, '20.11.0');

    const result = resolveNodeVersion(cwd, { HOME: home });
    expect(result!.binPath).toBe(binDir);
  });

  test('detects fnm install layout', () => {
    writeFileSync(resolve(cwd, '.nvmrc'), '20.11.0\n');
    const binDir = makeFnmInstall(home, '20.11.0');

    const result = resolveNodeVersion(cwd, { HOME: home });
    expect(result!.binPath).toBe(binDir);
  });

  test('respects NVM_DIR override', () => {
    const customNvm = resolve(TMP, 'custom-nvm');
    const binDir = resolve(customNvm, 'versions/node/v20.11.0/bin');
    mkdirSync(binDir, { recursive: true });
    const nodePath = resolve(binDir, NODE_BIN);
    writeFileSync(nodePath, '#!/bin/sh\n');
    if (!IS_WINDOWS) chmodSync(nodePath, 0o755);

    writeFileSync(resolve(cwd, '.nvmrc'), '20.11.0\n');

    const result = resolveNodeVersion(cwd, { HOME: home, NVM_DIR: customNvm });
    expect(result!.binPath).toBe(binDir);
  });
});
