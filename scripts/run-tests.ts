// Runs every package's `test` script, one package after another.
//
// Usage:
//   bun run test                                   # every package (CI, manual)
//   bun scripts/run-tests.ts --affected <files…>   # only packages those files can affect
//
// The pre-push hook (scripts/pre-push.ts) selects packages the same way from
// the files a push adds, so a push that only touches one package runs only its
// suite and those of the packages depending on it. CI still runs everything.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { testSuiteEnv } from './test-env';

export interface TestPackage {
  name: string;
  /** Repo-relative, `packages/<name>`. */
  dir: string;
  /** Repo-relative dirs of the workspace packages it depends on directly. */
  deps: string[];
  hasTest: boolean;
}

interface TestResult extends TestPackage {
  code: number;
  durationMs: number;
}

const ROOT = join(import.meta.dir, '..');

/**
 * Files outside `packages/` whose change can alter any suite's result: root
 * manifests and configs, shared protocol fixtures, and the test runner itself.
 */
const GLOBAL_INPUT =
  /^(package\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json|\.node-version|\.nvmrc|protocol\/.*|scripts\/(run-tests|test-env|pre-push)\.ts)$/;

/** `packages/<name>` for a repo-relative path inside a package, else null. */
function packageDirOf(file: string): string | null {
  const match = /^packages\/([^/]+)\//.exec(file);
  return match ? `packages/${match[1]}` : null;
}

function readManifests(root: string): { dir: string; manifest: Record<string, any> }[] {
  const packagesDir = join(root, 'packages');
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      dir: `packages/${entry.name}`,
      path: join(packagesDir, entry.name, 'package.json'),
    }))
    .filter(({ path }) => existsSync(path))
    .map(({ dir, path }) => ({ dir, manifest: JSON.parse(readFileSync(path, 'utf8')) }));
}

export function discoverPackages(root = ROOT): TestPackage[] {
  const manifests = readManifests(root);
  const nameToDir = new Map<string, string>();
  for (const { dir, manifest } of manifests) {
    if (typeof manifest.name === 'string') nameToDir.set(manifest.name, dir);
  }

  return manifests
    .map(({ dir, manifest }) => ({
      name: (manifest.name as string | undefined) ?? dir,
      dir,
      hasTest: Boolean(manifest.scripts?.test),
      deps: Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      })
        .map((name) => nameToDir.get(name))
        .filter((d): d is string => Boolean(d)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether `start` is, or depends on (transitively), one of `targets`. */
function reaches(start: string, targets: Set<string>, depsOf: Map<string, string[]>): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (targets.has(dir)) return true;
    if (seen.has(dir)) continue;
    seen.add(dir);
    stack.push(...(depsOf.get(dir) ?? []));
  }
  return false;
}

/**
 * Packages with a test suite whose result can change when `files` change: the
 * package contains one of the files, or depends on one that does (transitively).
 * A global input selects every package; other files outside `packages/` (docs,
 * CI config, unrelated scripts) select none.
 */
export function selectAffectedPackages(
  files: readonly string[],
  packages: readonly TestPackage[],
): TestPackage[] {
  const testable = packages.filter((pkg) => pkg.hasTest);
  if (files.some((file) => GLOBAL_INPUT.test(file))) return testable;

  const changedDirs = new Set(files.map(packageDirOf).filter((d): d is string => Boolean(d)));
  const depsOf = new Map(packages.map((pkg) => [pkg.dir, pkg.deps]));
  return testable.filter((pkg) => reaches(pkg.dir, changedDirs, depsOf));
}

async function runPackageTests(pkg: TestPackage, root: string): Promise<TestResult> {
  const start = performance.now();
  console.log(`\n=== ${pkg.name} ===`);

  const proc = Bun.spawn(['bun', 'run', 'test'], {
    cwd: join(root, pkg.dir),
    env: testSuiteEnv(process.env),
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  const code = await proc.exited;

  return {
    ...pkg,
    code,
    durationMs: performance.now() - start,
  };
}

function printSummary(results: readonly TestResult[]): void {
  console.log('\n=== Test summary ===');
  for (const result of results) {
    const status = result.code === 0 ? 'PASS' : `FAIL (${result.code})`;
    const seconds = (result.durationMs / 1000).toFixed(1);
    console.log(`${status.padEnd(10)} ${result.name} ${seconds}s`);
  }
}

/** Runs the suites in order and prints a summary; resolves to the exit code. */
export async function runTests(packages: readonly TestPackage[], root = ROOT): Promise<number> {
  const results: TestResult[] = [];
  for (const pkg of packages) {
    results.push(await runPackageTests(pkg, root));
  }
  printSummary(results);

  const failed = results.filter((result) => result.code !== 0);
  if (failed.length === 0) return 0;
  console.error(`\n${failed.length} package test suite(s) failed.`);
  return 1;
}

if (import.meta.main) {
  const all = discoverPackages();
  const at = process.argv.indexOf('--affected');
  const selected =
    at === -1
      ? all.filter((pkg) => pkg.hasTest)
      : selectAffectedPackages(process.argv.slice(at + 1), all);
  if (selected.length === 0) console.log('✓ No package test suite is affected by these files');
  process.exit(await runTests(selected));
}
