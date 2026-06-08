/**
 * Tests for the runner-side provider extension loader (provider-manifest-loader
 * §2.3/§2.4, §6.1). A valid `funny.provider` extension registers against the
 * runtime provider registry; malformed / over-menu / colliding / escaping
 * manifests are skipped with typed errors so one bad extension never breaks the
 * others.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { PROVIDER_MANIFEST_SCHEMA_VERSION } from '@funny/shared/provider-manifest-schema';
import { ACP_MANIFESTS } from '@funny/shared/provider-manifests';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { defaultProcessFactory } from '../agents/process-factory.js';
import {
  _clearRunnerManifests,
  getAdvertisedProviders,
  getRunnerManifest,
  installProviderExtensionFromPath,
  loadProviderExtensions,
  registerProviderExtension,
  removeProviderExtension,
  unregisterProviderExtension,
} from '../agents/provider-extensions.js';

let dir: string;

/** Write a provider extension dir: package.json (funny.provider) + manifest.json. */
function writeProviderExt(
  dirName: string,
  manifest: unknown,
  opts: { providerRef?: string; envelope?: unknown } = {},
): void {
  const extDir = join(dir, dirName);
  mkdirSync(extDir, { recursive: true });
  const ref = opts.providerRef ?? 'manifest.json';
  writeFileSync(
    join(extDir, 'package.json'),
    JSON.stringify({ name: `funny-${dirName}`, version: '1.0.0', funny: { provider: ref } }),
  );
  const file = opts.envelope ?? { schemaVersion: PROVIDER_MANIFEST_SCHEMA_VERSION, manifest };
  writeFileSync(join(extDir, ref), JSON.stringify(file));
}

/** A valid external manifest = a built-in shape under a fresh id. */
function externalManifest(id: string): Record<string, any> {
  return { ...JSON.parse(JSON.stringify(ACP_MANIFESTS.opencode)), id, label: id };
}

const baseStartOpts = {
  threadId: 't',
  projectPath: '/tmp',
  prompt: 'hi',
  model: 'default',
  permissionMode: 'autoEdit',
} as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'funny-provider-ext-'));
  _clearRunnerManifests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _clearRunnerManifests();
});

describe('loadProviderExtensions', () => {
  test('registers a valid external provider and resolves it via the factory', () => {
    writeProviderExt('myagent', externalManifest('myagent'));

    const res = loadProviderExtensions(dir);
    expect(res.errors).toEqual([]);
    expect(res.loaded.map((l) => l.id)).toContain('myagent');

    // The full manifest is kept runner-local.
    expect(getRunnerManifest('myagent')?.id).toBe('myagent');

    // The registry resolves the external id to a GenericACPProcess subclass.
    const proc = defaultProcessFactory.create({
      provider: 'myagent',
      threadId: 't',
      projectPath: '/tmp',
      prompt: 'hi',
      model: 'default',
      permissionMode: 'autoEdit',
    } as any);
    expect(proc).toBeInstanceOf(Object);
    expect(proc.constructor.name).not.toBe('SDKClaudeProcess');
  });

  test('rejects an id that collides with a built-in provider', () => {
    writeProviderExt('shadow-codex', externalManifest('codex'));

    const res = loadProviderExtensions(dir);
    expect(res.loaded).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].error).toMatch(/collides/);
  });

  test('skips a malformed manifest (unknown quirk) with a typed error, keeps the others', () => {
    const bad = externalManifest('bad-quirk');
    bad.quirks = { ...bad.quirks, doArbitraryThing: true };
    writeProviderExt('bad', bad);
    writeProviderExt('good', externalManifest('good'));

    const res = loadProviderExtensions(dir);
    expect(res.loaded.map((l) => l.id)).toEqual(['good']);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].dirName).toBe('bad');
  });

  test('rejects a wrong schemaVersion envelope', () => {
    writeProviderExt('verm', externalManifest('verm'), {
      envelope: { schemaVersion: 999, manifest: externalManifest('verm') },
    });
    const res = loadProviderExtensions(dir);
    expect(res.loaded).toEqual([]);
    expect(res.errors).toHaveLength(1);
  });

  test('skips a dir that is not a provider extension (no funny.provider)', () => {
    const plain = join(dir, 'not-a-provider');
    mkdirSync(plain, { recursive: true });
    writeFileSync(
      join(plain, 'package.json'),
      JSON.stringify({ name: 'x', funny: { client: 'a.mjs' } }),
    );

    const res = loadProviderExtensions(dir);
    expect(res.loaded).toEqual([]);
    expect(res.errors).toEqual([]);
  });

  test('returns empty for a non-existent dir', () => {
    const res = loadProviderExtensions(join(dir, 'does-not-exist'));
    expect(res).toEqual({ loaded: [], errors: [] });
  });
});

describe('live register / unregister (provider-install-ui §1)', () => {
  test('registerProviderExtension registers + advertises one provider with no rescan', () => {
    writeProviderExt('live-one', externalManifest('live-one'));

    const res = registerProviderExtension(dir, 'live-one');
    expect(res && res.ok).toBe(true);
    expect(getRunnerManifest('live-one')?.id).toBe('live-one');
    expect(getAdvertisedProviders().map((p) => p.id)).toContain('live-one');

    const proc = defaultProcessFactory.create({ provider: 'live-one', ...baseStartOpts } as any);
    expect(proc.constructor.name).not.toBe('SDKClaudeProcess');
  });

  test('unregisterProviderExtension de-registers live (factory falls back, not advertised)', () => {
    writeProviderExt('live-rm', externalManifest('live-rm'));
    registerProviderExtension(dir, 'live-rm');

    expect(unregisterProviderExtension('live-rm')).toBe(true);
    expect(getRunnerManifest('live-rm')).toBeUndefined();
    expect(getAdvertisedProviders().map((p) => p.id)).not.toContain('live-rm');
    const proc = defaultProcessFactory.create({ provider: 'live-rm', ...baseStartOpts } as any);
    expect(proc.constructor.name).toBe('SDKClaudeProcess');
  });

  test('registerProviderExtension returns a typed error on id collision', () => {
    writeProviderExt('shadow', externalManifest('codex'));
    const res = registerProviderExtension(dir, 'shadow');
    expect(res && res.ok).toBe(false);
    if (res && !res.ok) expect(res.error).toMatch(/collides/);
  });

  test('registerProviderExtension returns null for a non-provider dir', () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain, { recursive: true });
    writeFileSync(
      join(plain, 'package.json'),
      JSON.stringify({ name: 'x', funny: { client: 'a.mjs' } }),
    );
    expect(registerProviderExtension(dir, 'plain')).toBeNull();
  });

  test('unregisterProviderExtension refuses to remove a built-in', () => {
    expect(unregisterProviderExtension('codex')).toBe(false);
  });
});

describe('install / remove from a local path (provider-install-ui §2)', () => {
  /** Build a SOURCE package dir (outside the extensions dir) to install FROM. */
  function makeSource(id: string): string {
    const src = join(dir, '__src__', id);
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'package.json'),
      JSON.stringify({
        name: `funny-${id}`,
        version: '1.0.0',
        funny: { provider: 'manifest.json' },
      }),
    );
    writeFileSync(
      join(src, 'manifest.json'),
      JSON.stringify({
        schemaVersion: PROVIDER_MANIFEST_SCHEMA_VERSION,
        manifest: externalManifest(id),
      }),
    );
    return src;
  }

  test('installs a provider from a local path and registers it', () => {
    const extDir = join(dir, 'extensions');
    const res = installProviderExtensionFromPath(makeSource('inst-1'), extDir);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.loaded.id).toBe('inst-1');
    expect(getRunnerManifest('inst-1')?.id).toBe('inst-1');
    const proc = defaultProcessFactory.create({ provider: 'inst-1', ...baseStartOpts } as any);
    expect(proc.constructor.name).not.toBe('SDKClaudeProcess');
  });

  test('rejects + rolls back an install that collides with a built-in', () => {
    const extDir = join(dir, 'extensions');
    const res = installProviderExtensionFromPath(makeSource('codex'), extDir);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/collides/);
    // Rolled back: nothing left on disk for it.
    expect(loadProviderExtensions(extDir).loaded.map((l) => l.id)).not.toContain('codex');
  });

  test('removeProviderExtension de-registers and deletes the dir', () => {
    const extDir = join(dir, 'extensions');
    const installed = installProviderExtensionFromPath(makeSource('inst-2'), extDir);
    if (!installed.ok) throw new Error(installed.error);
    const rm = removeProviderExtension(extDir, installed.loaded.dirName);
    expect(rm.ok).toBe(true);
    expect(getRunnerManifest('inst-2')).toBeUndefined();
    expect(loadProviderExtensions(extDir).loaded).toEqual([]);
  });
});
