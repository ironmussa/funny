// Runs every package's `test` script, up to four packages at once
// (`FUNNY_TEST_CONCURRENCY` overrides it).
//
// Usage:
//   bun run test                                   # every package (CI, manual)
//   bun scripts/run-tests.ts --affected <files…>   # only packages those files can affect
//
// The pre-push hook (scripts/pre-push.ts) selects packages the same way from
// the files a push adds, so a push that only touches one package runs only its
// suite and those of the packages depending on it. CI still runs everything.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import { createOutputParser, isEventLine } from '../packages/shared/src/checks';
import { collectOutput } from './progress-io';
import { testSuiteEnv } from './test-env';
import { ProgressFile } from './test-progress';

export interface TestPackage {
  name: string;
  /** Repo-relative, `packages/<name>`. */
  dir: string;
  /** Repo-relative dirs of the workspace packages it depends on directly. */
  deps: string[];
  /** npm names of the non-workspace packages it declares. */
  externalDeps: string[];
  hasTest: boolean;
  /** The package's `test` script, when it has one. */
  testScript?: string;
}

/** A suite to run: the whole suite, or (vitest only) the tests related to `related`. */
export interface TestRun {
  pkg: TestPackage;
  /** Absolute paths for `vitest related`; null runs the whole suite. */
  related: string[] | null;
}

interface TestResult extends TestPackage {
  related: boolean;
  code: number;
  durationMs: number;
}

const ROOT = join(import.meta.dir, '..');

/**
 * Files outside `packages/` whose change can alter any suite's result: root
 * manifests and configs, shared protocol fixtures, and the test runner itself.
 */
const GLOBAL_INPUT =
  /^(package\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json|\.node-version|\.nvmrc|protocol\/.*|scripts\/(run-tests|test-env|test-progress|pre-push|lockfile-changes)\.ts)$/;

/**
 * Root dependency files. When the caller has worked out which external
 * dependencies they changed (`changedDeps`), they stop being global inputs.
 */
const DEPENDENCY_INPUT = /^(package\.json|bun\.lock)$/;

/**
 * Files inside a package that can change the result of tests that never import
 * them: anything outside `src/` (manifest, vitest/tsconfig, fixtures) and setup
 * files. A change to one runs the package's whole suite.
 */
const SUITE_INPUT = /^packages\/[^/]+\/(?!src\/)|\/setup\.[cm]?[jt]sx?$/;

/** `vitest run` in a test script, which `vitest related` can replace. */
const VITEST_RUN = /\bvitest run\b/;

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
    .map(({ dir, manifest }) => {
      const names = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      });
      const testScript = manifest.scripts?.test as string | undefined;
      return {
        name: (manifest.name as string | undefined) ?? dir,
        dir,
        hasTest: Boolean(testScript),
        ...(testScript ? { testScript } : {}),
        deps: names.map((name) => nameToDir.get(name)).filter((d): d is string => Boolean(d)),
        externalDeps: names.filter((name) => !nameToDir.has(name)),
      };
    })
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
 * Every external dependency some workspace package declares, for
 * `changedDependencies` (a root dependency outside this set is global).
 */
export function declaredExternalDeps(packages: readonly TestPackage[]): Set<string> {
  return new Set(packages.flatMap((pkg) => pkg.externalDeps));
}

/**
 * The suites `files` can affect and how much of each to run.
 *
 * A package is affected when it contains one of the files, declares one of
 * `changedDeps`, or depends (transitively) on a package that does. A global
 * input selects every package; other files outside `packages/` (docs, CI
 * config, unrelated scripts) select none.
 *
 * `changedDeps` is the set of external dependencies a `bun.lock` / root
 * `package.json` change touches (see `lockfile-changes.ts`). Undefined keeps
 * those files global, as does null ("cannot tell").
 *
 * A vitest suite runs only the tests related to the changed source files
 * (`vitest related`, which follows imports across packages), unless it is
 * affected through a dependency change or a suite input (config, manifest,
 * setup file), which no import graph shows: then it runs whole.
 */
export function planTests(
  files: readonly string[],
  packages: readonly TestPackage[],
  changedDeps?: ReadonlySet<string> | null,
  root = ROOT,
): TestRun[] {
  const testable = packages.filter((pkg) => pkg.hasTest);
  const whole = (pkg: TestPackage): TestRun => ({ pkg, related: null });
  if (changedDeps === null) return testable.map(whole);
  const isGlobal = (file: string) =>
    GLOBAL_INPUT.test(file) && !(changedDeps && DEPENDENCY_INPUT.test(file));
  if (files.some(isGlobal)) return testable.map(whole);

  const depsOf = new Map(packages.map((pkg) => [pkg.dir, pkg.deps]));
  const packageFiles = files.filter((file) => packageDirOf(file));
  const changedDirs = new Set(packageFiles.map((file) => packageDirOf(file)!));
  // Dirs whose suites no import graph can narrow down.
  const wholeDirs = new Set(
    packageFiles.filter((file) => SUITE_INPUT.test(file)).map((file) => packageDirOf(file)!),
  );
  for (const pkg of packages) {
    if (changedDeps && pkg.externalDeps.some((name) => changedDeps.has(name))) {
      changedDirs.add(pkg.dir);
      wholeDirs.add(pkg.dir);
    }
  }

  const sources = packageFiles
    .filter((file) => !SUITE_INPUT.test(file))
    .map((file) => join(root, file))
    .filter((path) => existsSync(path));
  return testable
    .filter((pkg) => reaches(pkg.dir, changedDirs, depsOf))
    .map((pkg) =>
      pkg.testScript && VITEST_RUN.test(pkg.testScript) && !reaches(pkg.dir, wholeDirs, depsOf)
        ? { pkg, related: sources }
        : whole(pkg),
    );
}

/** The packages `planTests` selects (whole or related). */
export function selectAffectedPackages(
  files: readonly string[],
  packages: readonly TestPackage[],
  changedDeps?: ReadonlySet<string> | null,
): TestPackage[] {
  return planTests(files, packages, changedDeps).map((run) => run.pkg);
}

const shellQuote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

const PROGRESS_REPORTER = join(import.meta.dir, 'vitest-progress-reporter.ts');

interface CommandOptions {
  /** Add the progress reporter to a vitest suite's default one. */
  progress?: boolean;
  /** Cap a vitest suite's workers (`--maxWorkers`). */
  maxWorkers?: number;
}

/** vitest flags for `options`, or an empty string. */
function vitestFlags({ progress, maxWorkers }: CommandOptions): string {
  const flags = [
    progress && `--reporter=default --reporter=${shellQuote(PROGRESS_REPORTER)}`,
    maxWorkers && `--maxWorkers=${maxWorkers}`,
  ];
  return flags.filter(Boolean).join(' ');
}

/**
 * The command for a run: the package's `test` script, narrowed for `related`,
 * with the vitest flags `options` asks for added to a vitest suite.
 */
function testCommand(run: TestRun, options: CommandOptions = {}): string[] {
  const script = run.pkg.testScript ?? '';
  const flags = VITEST_RUN.test(script) ? vitestFlags(options) : '';
  if (!run.related && !flags) return ['bun', 'run', 'test'];
  let command = run.related
    ? script.replace(VITEST_RUN, 'vitest related --run --passWithNoTests')
    : script;
  if (flags) command = command.replace(/\bvitest (run|related)\b/, (match) => `${match} ${flags}`);
  return ['sh', '-c', [command, ...(run.related ?? []).map(shellQuote)].join(' ')];
}

/** Suites run at once; `FUNNY_TEST_CONCURRENCY` overrides it. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Workers for each vitest suite when `concurrency` suites run at once: an equal
 * share of the cores. Left to vitest (about one per core) a suite oversubscribes
 * the machine next to the others, and every file then pays more for its jsdom
 * environment and imports: on 20 cores, 60 client test files took 117 s with
 * vitest's default and 94 s with 4 workers. Undefined (vitest's default) when
 * suites run one at a time.
 */
export function workersPerSuite(concurrency: number, cores = availableParallelism()) {
  return concurrency > 1 ? Math.max(1, Math.floor(cores / concurrency)) : undefined;
}

function concurrencyFrom(env: Record<string, string | undefined>): number {
  const value = Number(env.FUNNY_TEST_CONCURRENCY);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY;
}

const label = (run: TestRun) => `${run.pkg.name}${run.related ? ' (related tests)' : ''}`;

/**
 * Runs one suite, handing every output line to `onLine` (and, when `onLine` is
 * given, adding the progress reporter to a vitest suite), with a vitest suite's
 * workers capped at `maxWorkers`. With `buffered`, its
 * output is collected and printed in one block when it ends, so suites running
 * side by side do not interleave; otherwise it streams through. Reporter event
 * lines are never printed.
 */
async function runPackageTests(
  run: TestRun,
  root: string,
  {
    buffered,
    onLine,
    maxWorkers,
  }: { buffered: boolean; onLine?: (line: string) => void; maxWorkers?: number },
): Promise<TestResult> {
  const { pkg } = run;
  const start = performance.now();
  console.log(buffered ? `▶ ${label(run)}` : `\n=== ${label(run)} ===`);

  const env = testSuiteEnv(process.env);
  // `sh -c` does not get the bin dirs `bun run` adds to PATH.
  const bins = [join(root, pkg.dir, 'node_modules', '.bin'), join(root, 'node_modules', '.bin')];
  const proc = Bun.spawn(testCommand(run, { progress: Boolean(onLine), maxWorkers }), {
    cwd: join(root, pkg.dir),
    env: { ...env, PATH: [...bins, env.PATH].filter(Boolean).join(':') },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: buffered ? 'ignore' : 'inherit',
  });
  const { code, durationMs } = await collectOutput(proc, {
    title: label(run),
    buffered,
    start,
    onLine,
    hide: isEventLine,
  });
  return { ...pkg, related: Boolean(run.related), code, durationMs };
}

function printSummary(results: readonly TestResult[]): void {
  console.log('\n=== Test summary ===');
  for (const result of results) {
    const status = result.code === 0 ? 'PASS' : `FAIL (${result.code})`;
    const seconds = (result.durationMs / 1000).toFixed(1);
    const scope = result.related ? ' (related)' : '';
    console.log(`${status.padEnd(10)} ${result.name}${scope} ${seconds}s`);
  }
}

/**
 * Runs the suites, up to `concurrency` at once, and prints a summary in input
 * order; resolves to the exit code. A bare package runs its whole suite. With
 * `progressPath` (`FUNNY_TEST_PROGRESS`), live progress is written there for
 * the client's `test-progress` visualizer.
 */
export async function runTests(
  runs: readonly (TestPackage | TestRun)[],
  root = ROOT,
  concurrency = concurrencyFrom(process.env),
  progressPath = process.env.FUNNY_TEST_PROGRESS,
): Promise<number> {
  const queue = runs.map((run) => ('pkg' in run ? run : { pkg: run, related: null }));
  const results: TestResult[] = new Array(queue.length);
  const buffered = concurrency > 1 && queue.length > 1;
  const maxWorkers = workersPerSuite(Math.min(concurrency, queue.length));
  const progress = progressPath
    ? new ProgressFile(
        progressPath,
        queue.map((run) => ({ name: run.pkg.name, related: Boolean(run.related) })),
        { concurrency },
      )
    : null;
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const index = next++;
      const parse = createOutputParser();
      progress?.start(index);
      const onLine = progress ? (line: string) => progress.report(index, parse(line)) : undefined;
      const result = await runPackageTests(queue[index], root, { buffered, onLine, maxWorkers });
      progress?.finish(index, result.code, result.durationMs);
      results[index] = result;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  printSummary(results);

  const failed = results.filter((result) => result.code !== 0);
  progress?.close(failed.length);
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
