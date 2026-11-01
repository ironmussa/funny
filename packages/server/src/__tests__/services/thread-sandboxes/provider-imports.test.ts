/**
 * Provider isolation (change `thread-sandboxes`): lifecycle, routing, backup and
 * routes depend only on the provider-neutral contract, so adding a provider never
 * touches them. Production code may import `services/thread-sandboxes/providers/`
 * only from inside `providers/` or from `provider-catalog.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const SERVER_SRC = join(import.meta.dir, '..', '..', '..');
const SANDBOXES = 'services/thread-sandboxes';
const PROVIDERS_DIR = `${SANDBOXES}/providers/`;
const CATALOG = `${SANDBOXES}/provider-catalog.ts`;
const IMPORT_RE =
  /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+|\bexport\s+\*\s+from\s+)['"]([^'"]+)['"]/gm;

function providerImports(file: string, source: string): string[] {
  if (file.startsWith(PROVIDERS_DIR) || file === CATALOG) return [];
  return [...source.matchAll(IMPORT_RE)]
    .map((m) => m[1])
    .filter((spec) =>
      spec.startsWith('.')
        ? `${normalize(join(dirname(file), spec)).replaceAll('\\', '/')}/`.startsWith(PROVIDERS_DIR)
        : /(?:^|\/)thread-sandboxes\/providers(?:\/|$)/.test(spec),
    );
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
  test('rule accepts the contract, the catalog and provider-internal imports', () => {
    expect(providerImports(`${SANDBOXES}/lifecycle.ts`, "import t from './contract.js';")).toEqual(
      [],
    );
    expect(providerImports(CATALOG, "import { e } from './providers/boat/entry.js';")).toEqual([]);
    expect(
      providerImports(`${PROVIDERS_DIR}boat/a.ts`, "import { r } from '../shared/retry.js';"),
    ).toEqual([]);
  });

  test('rule rejects provider imports from lifecycle, routes and barrels', () => {
    expect(
      providerImports(`${SANDBOXES}/lifecycle.ts`, "import { b } from './providers/boat/b.js';"),
    ).toHaveLength(1);
    expect(
      providerImports(
        'routes/infra.ts',
        "const m = await import('../services/thread-sandboxes/providers/fake/fake-provider.js');",
      ),
    ).toHaveLength(1);
    expect(
      providerImports(`${SANDBOXES}/index.ts`, "export * from './providers/boat/entry.js';"),
    ).toHaveLength(1);
  });

  test('no production module imports a provider outside providers/ and the catalog', () => {
    const violations = productionFiles(SERVER_SRC).flatMap((abs) => {
      const file = relative(SERVER_SRC, abs).replaceAll('\\', '/');
      return providerImports(file, readFileSync(abs, 'utf8')).map((spec) => `${file}: ${spec}`);
    });
    expect(violations).toEqual([]);
  });
});
