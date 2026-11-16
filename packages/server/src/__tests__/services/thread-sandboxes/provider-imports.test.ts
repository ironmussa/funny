/**
 * Provider isolation (change `thread-sandboxes`): the server's lifecycle,
 * routing, backup and routes depend only on the provider-neutral contract, so
 * adding a provider never touches them. Production code reaches providers only
 * through the catalog (`productionSandboxProviders` from `@funny/sandbox`) and
 * never imports `@funny/sandbox/providers/*`; tests may (the fake provider).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SERVER_SRC = join(import.meta.dir, '..', '..', '..');
const IMPORT_RE =
  /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+|\bexport\s+\*\s+from\s+)['"]([^'"]+)['"]/gm;

function providerImports(source: string): string[] {
  return [...source.matchAll(IMPORT_RE)]
    .map((m) => m[1])
    .filter((spec) => /^@funny\/sandbox\/providers(?:\/|$)/.test(spec));
}

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) productionFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('sandbox provider isolation', () => {
  test('rule accepts the catalog and rejects provider imports', () => {
    expect(providerImports("import { productionSandboxProviders } from '@funny/sandbox';")).toEqual(
      [],
    );
    expect(providerImports("import { e } from '@funny/sandbox/providers/fake';")).toHaveLength(1);
    expect(
      providerImports("const m = await import('@funny/sandbox/providers/boat');"),
    ).toHaveLength(1);
    expect(providerImports("export * from '@funny/sandbox/providers';")).toHaveLength(1);
  });

  test('no production module imports a provider directly', () => {
    const violations = productionFiles(SERVER_SRC).flatMap((abs) => {
      const file = relative(SERVER_SRC, abs).replaceAll('\\', '/');
      return providerImports(readFileSync(abs, 'utf8')).map((spec) => `${file}: ${spec}`);
    });
    expect(violations).toEqual([]);
  });
});
