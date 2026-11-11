import { describe, expect, test } from 'bun:test';

import { changedDependencies, type DependencySnapshot } from '../lockfile-changes';

type Packages = Record<string, unknown[]>;

const entry = (name: string, version: string, deps: Record<string, string> = {}) => [
  `${name}@${version}`,
  '',
  { dependencies: deps },
  'sha512-x',
];

/** A `bun.lock` as bun writes it: JSON with trailing commas. */
function lock(packages: Packages, root: Record<string, string> = {}, extra = {}): string {
  const body = {
    lockfileVersion: 1,
    workspaces: { '': { name: 'root', dependencies: root } },
    ...extra,
    packages,
  };
  return JSON.stringify(body, null, 2).replace(/\n(\s*)([}\]])/g, ',\n$1$2');
}

const manifest = (fields: Record<string, unknown>) => JSON.stringify({ name: 'root', ...fields });

const base: Packages = {
  sdk: entry('sdk', '1.0.0', { 'sdk-linux': '1.0.0' }),
  'sdk-linux': entry('sdk-linux', '1.0.0'),
  wrapper: entry('wrapper', '2.0.0', { sdk: '^1' }),
  hono: entry('hono', '4.0.0'),
  '@scope/tool': entry('@scope/tool', '3.0.0'),
};

const snap = (packages: Packages, rootManifest = manifest({})): DependencySnapshot => ({
  lock: lock(packages),
  rootManifest,
});

const declared = new Set(['sdk', 'wrapper', 'hono', '@scope/tool']);
const names = (set: Set<string> | null) => (set ? [...set].sort() : set);

describe('changedDependencies', () => {
  test('a version bump changes the package and every package depending on it', () => {
    const after = {
      ...base,
      sdk: entry('sdk', '1.1.0', { 'sdk-linux': '1.1.0' }),
      'sdk-linux': entry('sdk-linux', '1.1.0'),
    };
    expect(names(changedDependencies(snap(base), snap(after), declared))).toEqual([
      'sdk',
      'sdk-linux',
      'wrapper',
    ]);
  });

  test('scoped names are read from the entry, not the key', () => {
    const after = { ...base, '@scope/tool': entry('@scope/tool', '3.1.0') };
    expect(names(changedDependencies(snap(base), snap(after), declared))).toEqual(['@scope/tool']);
  });

  test('added and removed entries count as changed', () => {
    const { hono: _, ...withoutHono } = base;
    const after = { ...withoutHono, zod: entry('zod', '4.0.0') };
    expect(names(changedDependencies(snap(base), snap(after), declared))).toEqual(['hono', 'zod']);
  });

  test('an unchanged lock and root dependency list change nothing', () => {
    expect(names(changedDependencies(snap(base), snap(base), declared))).toEqual([]);
  });

  test('a root script change is not global', () => {
    const before = snap(base, manifest({ scripts: { lint: 'a' } }));
    const after = snap(base, manifest({ scripts: { lint: 'b' } }));
    expect(names(changedDependencies(before, after, declared))).toEqual([]);
  });

  test('a root dependency spec change counts when a workspace package declares it', () => {
    const before = snap(base, manifest({ dependencies: { sdk: '^1.0.0' } }));
    const after = snap(base, manifest({ dependencies: { sdk: '^1.1.0' } }));
    // `wrapper` depends on `sdk`, so it is reached too.
    expect(names(changedDependencies(before, after, declared))).toEqual(['sdk', 'wrapper']);
  });

  test('a change reaching a root-only dependency is global (hoisting)', () => {
    const before = snap(base, manifest({ devDependencies: { wrapper: '^2' } }));
    const after = {
      ...snap({ ...base, sdk: entry('sdk', '1.1.0', { 'sdk-linux': '1.0.0' }) }),
      rootManifest: before.rootManifest,
    };
    // `wrapper` depends on `sdk`, and only the root declares `wrapper`.
    expect(changedDependencies(before, after, new Set(['sdk']))).toBeNull();
  });

  test('other root manifest fields are global', () => {
    const before = snap(base, manifest({ workspaces: ['packages/*'] }));
    const after = snap(base, manifest({ workspaces: ['packages/*', 'tools/*'] }));
    expect(changedDependencies(before, after, declared)).toBeNull();
  });

  test('other lock sections are global', () => {
    const before = { lock: lock(base, {}, { overrides: { hono: '4.0.0' } }), rootManifest: null };
    const after = { lock: lock(base, {}, { overrides: { hono: '4.1.0' } }), rootManifest: null };
    expect(changedDependencies(before, after, declared)).toBeNull();
  });

  test('a lock that does not parse is global', () => {
    const after = { lock: '{ not json', rootManifest: manifest({}) };
    expect(changedDependencies(snap(base), after, declared)).toBeNull();
  });
});
