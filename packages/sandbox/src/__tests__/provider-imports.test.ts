/**
 * Provider isolation (change `thread-sandboxes`): lifecycle, routing, backup and
 * routes depend only on the provider-neutral contract, so adding a provider never
 * touches them. Inside this package, only `providers/` and `provider-catalog.ts`
 * may import a provider. Hosts reach providers only through the catalog
 * (`productionSandboxProviders` from `@funny/sandbox`); the server checks its
 * own side in its `provider-imports.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const SANDBOX_SRC = join(import.meta.dir, '..');
const PROVIDERS_DIR = 'providers/';
const CATALOG = 'provider-catalog.ts';
const IMPORT_RE =
  /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+|\bexport\s+\*\s+from\s+)['"]([^'"]+)['"]/gm;

/** Provider imports of `file` (relative to the package `src`) that break the rule. */
function providerImports(file: string, source: string): string[] {
  if (file.startsWith(PROVIDERS_DIR) || file === CATALOG) return [];
  return [...source.matchAll(IMPORT_RE)]
    .map((m) => m[1])
    .filter((spec) =>
      spec.startsWith('.')
        ? `${normalize(join(dirname(file), spec)).replaceAll('\\', '/')}/`.startsWith(PROVIDERS_DIR)
        : /^@funny\/sandbox\/providers(?:\/|$)/.test(spec),
    );
}

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'testing' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) productionFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('sandbox provider isolation', () => {
  test('rule accepts the contract, the catalog and provider-internal imports', () => {
    expect(providerImports('template-manager.ts', "import t from './contract.js';")).toEqual([]);
    expect(providerImports(CATALOG, "import { e } from './providers/boat/entry.js';")).toEqual([]);
    expect(
      providerImports(`${PROVIDERS_DIR}boat/a.ts`, "import { r } from '../shared/retry.js';"),
    ).toEqual([]);
  });

  test('rule rejects provider imports from the rest of the package', () => {
    expect(
      providerImports('template-manager.ts', "import { b } from './providers/boat/b.js';"),
    ).toHaveLength(1);
    expect(providerImports('index.ts', "export * from './providers/boat/entry.js';")).toHaveLength(
      1,
    );
  });

  test('no module of the package imports a provider outside providers/ and the catalog', () => {
    const violations = productionFiles(SANDBOX_SRC).flatMap((abs) => {
      const file = relative(SANDBOX_SRC, abs).replaceAll('\\', '/');
      return providerImports(file, readFileSync(abs, 'utf8')).map((spec) => `${file}: ${spec}`);
    });
    expect(violations).toEqual([]);
  });
});
