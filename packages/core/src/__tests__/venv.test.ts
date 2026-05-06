/**
 * Tests for env/venv.ts — Python venv detection and env-var resolution.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { delimiter, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { resolvePyVenv } from '../env/venv.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const TMP = resolve(__dir, '__tmp_venv_test__');

const IS_WINDOWS = process.platform === 'win32';
const BIN_DIR = IS_WINDOWS ? 'Scripts' : 'bin';
const PYTHON_BIN = IS_WINDOWS ? 'python.exe' : 'python';

function makeVenv(cwd: string, name: string): string {
  const venvPath = resolve(cwd, name);
  const binPath = resolve(venvPath, BIN_DIR);
  mkdirSync(binPath, { recursive: true });
  const pythonPath = resolve(binPath, PYTHON_BIN);
  writeFileSync(pythonPath, '#!/bin/sh\n');
  if (!IS_WINDOWS) chmodSync(pythonPath, 0o755);
  return venvPath;
}

describe('resolvePyVenv', () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  test('returns null when no venv directory exists', () => {
    expect(resolvePyVenv(TMP, {})).toBeNull();
  });

  test('returns null when venv directory exists but has no python binary', () => {
    mkdirSync(resolve(TMP, '.venv', BIN_DIR), { recursive: true });
    expect(resolvePyVenv(TMP, {})).toBeNull();
  });

  test('detects .venv and returns env mutations', () => {
    const venvPath = makeVenv(TMP, '.venv');
    const result = resolvePyVenv(TMP, { PATH: '/usr/bin' });

    expect(result).not.toBeNull();
    expect(result!.venvPath).toBe(venvPath);
    expect(result!.env.VIRTUAL_ENV).toBe(venvPath);
    expect(result!.env.VIRTUAL_ENV_PROMPT).toBe('.venv');
    expect(result!.env.PYTHONHOME).toBeUndefined();
    expect(result!.env.PATH).toBe(`${resolve(venvPath, BIN_DIR)}${delimiter}/usr/bin`);
  });

  test('detects venv (without dot) as fallback', () => {
    const venvPath = makeVenv(TMP, 'venv');
    const result = resolvePyVenv(TMP, {});

    expect(result).not.toBeNull();
    expect(result!.venvPath).toBe(venvPath);
  });

  test('prefers .venv over venv when both exist', () => {
    const dotVenv = makeVenv(TMP, '.venv');
    makeVenv(TMP, 'venv');

    const result = resolvePyVenv(TMP, {});
    expect(result!.venvPath).toBe(dotVenv);
  });

  test('handles empty PATH gracefully', () => {
    const venvPath = makeVenv(TMP, '.venv');
    const result = resolvePyVenv(TMP, {});

    expect(result!.env.PATH).toBe(resolve(venvPath, BIN_DIR));
  });

  test('UV_PROJECT_ENVIRONMENT override takes precedence over .venv', () => {
    makeVenv(TMP, '.venv');
    const customVenv = makeVenv(TMP, '.uv-env');

    const result = resolvePyVenv(TMP, { UV_PROJECT_ENVIRONMENT: '.uv-env' });
    expect(result!.venvPath).toBe(customVenv);
    expect(result!.env.VIRTUAL_ENV).toBe(customVenv);
  });

  test('UV_PROJECT_ENVIRONMENT pointing nowhere falls back to .venv', () => {
    const venvPath = makeVenv(TMP, '.venv');

    const result = resolvePyVenv(TMP, { UV_PROJECT_ENVIRONMENT: '.does-not-exist' });
    expect(result!.venvPath).toBe(venvPath);
  });

  test('UV_PROJECT_ENVIRONMENT supports absolute paths', () => {
    const customVenv = makeVenv(TMP, 'absolute-uv');

    const result = resolvePyVenv(TMP, { UV_PROJECT_ENVIRONMENT: customVenv });
    expect(result!.venvPath).toBe(customVenv);
  });
});
