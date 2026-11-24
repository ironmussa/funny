// Coverage-based test selection inside a `bun test` package.
//
// `scripts/run-tests.ts` selects whole packages. This script goes one level
// down for `bun test` packages: it
// records which source files each test file actually executes, then selects
// the test files whose recorded sources a change touches. Imports that a
// static graph cannot follow (dynamic `import()`, registries, DI) show up in
// the map because coverage sees what ran.
//
// Usage:
//   bun scripts/test-impact.ts fetch                 # latest map from CI (gh)
//   bun scripts/test-impact.ts build <packages/name> [--out map.json] [--jobs N]
//   bun scripts/test-impact.ts select <map.json> <changed files…>
//   bun scripts/test-impact.ts evaluate <map.json> [--commits N]
//
// CI builds the maps of IMPACT_PACKAGES on every push to master and uploads
// them as the `test-impact-maps` artifact; `fetch` downloads the latest one
// into MAP_DIR, where `run-tests.ts --affected` and the pre-push hook look.
// Without a map (or with one they cannot place in history) a package runs its
// whole suite, as before.
//
// `build` runs each test file alone with `--coverage --coverage-reporter=lcov`
// and the flags of the package's own `test` script. Paths in the map are
// repo-relative, so a change in another package (shared, core) selects the
// tests that executed it.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { testSuiteEnv } from './test-env';

const ROOT = join(import.meta.dir, '..');

/** Packages CI builds a map for: the `bun test` suites where narrowing pays off. */
export const IMPACT_PACKAGES = ['packages/server'];

/** Where `fetch` puts the maps and the test runners read them (ignored by git). */
export const MAP_DIR = join(ROOT, 'node_modules', '.cache', 'funny-test-impact');

/** The CI artifact holding the maps. */
const ARTIFACT = 'test-impact-maps';

export interface ImpactMap {
  /** Repo-relative package dir, `packages/<name>`. */
  package: string;
  /** Commit the map was built at. */
  commit: string;
  generatedAt: string;
  /** Repo-relative test file → repo-relative source files it executed. */
  tests: Record<string, string[]>;
  /**
   * Test files every selection runs, with why: their coverage run failed, or
   * it saw no source file (the test reads sources as text, spawns a process,
   * or tests only a library), so the map cannot say what they depend on.
   */
  alwaysRun: Record<string, string>;
  /** Wall time of each test file's coverage run, to weigh selections by time. */
  durationsMs: Record<string, number>;
}

export type Selection =
  | { kind: 'all'; reason: string; tests: string[] }
  | { kind: 'some'; tests: string[] };

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/**
 * Source files coverage can see. Anything else in a package (JSON, SQL,
 * fixtures, configs) can be read at runtime without coverage noticing.
 */
const CODE_FILE = /\.[cm]?[jt]sx?$/;
/** A `bun test` script that the test files can be appended to. */
export const BUN_TEST = /^bun test\b/;

/** Source files with at least one executed line or function, from an lcov report. */
export function coveredFiles(lcov: string): string[] {
  const files: string[] = [];
  let current: string | null = null;
  let hit = false;
  for (const line of lcov.split('\n')) {
    if (line.startsWith('SF:')) {
      current = line.slice(3).trim();
      hit = false;
    } else if (current && (/^DA:\d+,[1-9]/.test(line) || /^FNH:[1-9]/.test(line))) {
      hit = true;
    } else if (line === 'end_of_record') {
      if (current && hit) files.push(current);
      current = null;
    }
  }
  return files;
}

/** The flags of a `bun test` script (`bun test --isolate --timeout 20000` → those two). */
export function bunTestFlags(script: string): string[] {
  const match = /\bbun test\b(.*)$/.exec(script);
  if (!match) throw new Error(`not a bun test script: ${script}`);
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/**
 * The test files to run for `changed` (repo-relative). A changed test file of
 * the package selects itself, even one the map has never seen. A change the
 * map cannot judge (a non-code file in the package, a test setup file)
 * selects everything. Tests in `alwaysRun` are always selected.
 */
export function selectTests(map: ImpactMap, changed: readonly string[]): Selection {
  const prefix = `${map.package}/`;
  for (const file of changed) {
    const reason = file.startsWith(prefix) ? unjudgeable(file) : null;
    if (reason) return { kind: 'all', reason, tests: Object.keys(map.tests).sort() };
  }
  const bySource = testsBySource(map);
  const selected = new Set<string>(Object.keys(map.alwaysRun));
  for (const file of changed) {
    for (const test of testsFor(file, prefix, bySource)) selected.add(test);
  }
  return { kind: 'some', tests: [...selected].sort() };
}

/** The tests a change to `file` selects: itself if it is a test of the package, else its executors. */
function testsFor(file: string, prefix: string, bySource: ReadonlyMap<string, string[]>): string[] {
  if (!TEST_FILE.test(file)) return bySource.get(file) ?? [];
  return file.startsWith(prefix) ? [file] : [];
}

/** Why the map cannot judge a change to `file` of its package, or null when it can. */
function unjudgeable(file: string): string | null {
  if (!CODE_FILE.test(file)) return `${file} is not code coverage can see`;
  if (/\/(setup|preload)[^/]*\.[cm]?[jt]sx?$/.test(file)) return `${file} is a test setup file`;
  return null;
}

/** Source file → the test files that executed it. */
function testsBySource(map: ImpactMap): Map<string, string[]> {
  const bySource = new Map<string, string[]>();
  for (const [test, sources] of Object.entries(map.tests)) {
    for (const source of sources) {
      const tests = bySource.get(source);
      if (tests) tests.push(test);
      else bySource.set(source, [test]);
    }
  }
  return bySource;
}

/** Whether `value` has the shape of an `ImpactMap`. */
export function isImpactMap(value: unknown): value is ImpactMap {
  if (typeof value !== 'object' || value === null) return false;
  const map: Partial<Record<keyof ImpactMap, unknown>> = value;
  const isRecord = (v: unknown): v is object =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  return (
    typeof map.package === 'string' &&
    typeof map.commit === 'string' &&
    /^[0-9a-f]{40}$/.test(map.commit) &&
    isRecord(map.tests) &&
    Object.values(map.tests).every(
      (sources) => Array.isArray(sources) && sources.every((s) => typeof s === 'string'),
    ) &&
    isRecord(map.alwaysRun) &&
    isRecord(map.durationsMs)
  );
}

export const mapPathFor = (pkgDir: string, dir = MAP_DIR) => join(dir, `${basename(pkgDir)}.json`);

/** The map for `pkgDir` in `dir`, or null when there is none or it is malformed. */
export function loadMap(pkgDir: string, dir = MAP_DIR): ImpactMap | null {
  const path = mapPathFor(pkgDir, dir);
  if (!existsSync(path)) return null;
  try {
    const map: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isImpactMap(map) && map.package === pkgDir ? map : null;
  } catch {
    return null;
  }
}

function gitOrNull(args: string[], cwd: string): string | null {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: testSuiteEnv(process.env),
  });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}

function git(args: string[], cwd = ROOT): string {
  const out = gitOrNull(args, cwd);
  if (out === null) throw new Error(`git ${args.join(' ')} failed`);
  return out;
}

const lines = (out: string) => out.split('\n').filter(Boolean);

/**
 * Files whose content can differ between the tree the map was built from and
 * `head`: the changes on either side since their merge base. Treating them as
 * changed keeps a stale map sound (it only selects more as it ages). Null when
 * the map's commit is not in the local repository.
 */
export function driftSince(mapCommit: string, head: string, cwd = ROOT): string[] | null {
  const base = gitOrNull(['merge-base', mapCommit, head], cwd)?.trim();
  if (!base) return null;
  const sides = [mapCommit, head].map((rev) => gitOrNull(['diff', '--name-only', base, rev], cwd));
  if (sides.some((side) => side === null)) return null;
  return [...new Set(sides.flatMap((side) => lines(side!)))];
}

/** How `run-tests.ts` narrows a package: the files to run, or why it runs whole. */
export type Narrowing = { tests: string[] } | { whole: string };

/**
 * The test files of `pkgDir` (package-relative, `./`-prefixed for `bun test`)
 * that `files` changed at `heads` can affect, from the map in `mapDir`.
 */
export function narrowPackage(
  pkgDir: string,
  files: readonly string[],
  heads: readonly string[],
  { root = ROOT, mapDir = MAP_DIR }: { root?: string; mapDir?: string } = {},
): Narrowing {
  const map = loadMap(pkgDir, mapDir);
  if (!map) return { whole: 'no test-impact map (bun scripts/test-impact.ts fetch)' };
  if (heads.length === 0) return { whole: 'no pushed commit to place the map against' };
  const changed = new Set(files);
  for (const head of heads) {
    const drift = driftSince(map.commit, head, root);
    if (drift === null) return { whole: `map commit ${map.commit.slice(0, 8)} is not local` };
    for (const file of drift) changed.add(file);
  }
  const selection = selectTests(map, [...changed]);
  if (selection.kind === 'all') return { whole: selection.reason };
  return {
    tests: selection.tests
      .filter((test) => existsSync(join(root, test)))
      .map((test) => `./${relative(pkgDir, test)}`),
  };
}

async function runCoverage(
  pkgDir: string,
  test: string,
  flags: string[],
): Promise<{ sources: string[]; code: number; ms: number }> {
  const absPkg = join(ROOT, pkgDir);
  const covDir = mkdtempSync(join(tmpdir(), 'test-impact-'));
  const started = performance.now();
  try {
    const proc = Bun.spawn(
      [
        'bun',
        'test',
        ...flags,
        '--coverage',
        '--coverage-reporter=lcov',
        `--coverage-dir=${covDir}`,
        `./${relative(absPkg, join(ROOT, test))}`,
      ],
      {
        cwd: absPkg,
        stdout: 'ignore',
        stderr: 'ignore',
        env: { ...testSuiteEnv(process.env), CI: '1' },
      },
    );
    const code = await proc.exited;
    let lcov = '';
    try {
      lcov = readFileSync(join(covDir, 'lcov.info'), 'utf8');
    } catch {}
    const sources = coveredFiles(lcov).map((file) => relative(ROOT, resolve(absPkg, file)));
    return { sources: [...new Set(sources)].sort(), code, ms: performance.now() - started };
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
}

async function build(pkgDir: string, out: string, jobs: number): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(ROOT, pkgDir, 'package.json'), 'utf8'));
  const flags = bunTestFlags(manifest.scripts?.test ?? '');
  const tests = lines(git(['ls-files', pkgDir]))
    .filter((file) => TEST_FILE.test(file))
    .sort();
  const map: ImpactMap = {
    package: pkgDir,
    commit: git(['rev-parse', 'HEAD']).trim(),
    generatedAt: new Date().toISOString(),
    tests: {},
    alwaysRun: {},
    durationsMs: {},
  };
  const queue = [...tests];
  let done = 0;
  let totalMs = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      for (let test = queue.shift(); test; test = queue.shift()) {
        const result = await runCoverage(pkgDir, test, flags);
        map.tests[test] = result.sources;
        map.durationsMs[test] = Math.round(result.ms);
        if (result.code !== 0) map.alwaysRun[test] = `coverage run exited ${result.code}`;
        else if (result.sources.length === 0) map.alwaysRun[test] = 'coverage saw no source file';
        totalMs += result.ms;
        done++;
        console.error(
          `[${done}/${tests.length}] ${map.alwaysRun[test] ? `✗ ${map.alwaysRun[test]}:` : '✓'} ${test} (${result.sources.length} sources, ${Math.round(result.ms)} ms)`,
        );
      }
    }),
  );
  map.tests = Object.fromEntries(Object.entries(map.tests).sort());
  map.durationsMs = Object.fromEntries(Object.entries(map.durationsMs).sort());
  map.alwaysRun = Object.fromEntries(Object.entries(map.alwaysRun).sort());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(map, null, 2)}\n`);
  console.error(
    `Wrote ${out}: ${tests.length} test files, ${Object.keys(map.alwaysRun).length} always run, ${(totalMs / 1000).toFixed(1)} s of test time`,
  );
}

/** Downloads the maps of the latest successful CI run on master into MAP_DIR. */
function fetchMaps(): number {
  const gh = (args: string[]) => {
    const result = Bun.spawnSync(['gh', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
      console.error(`gh ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
      return null;
    }
    return result.stdout.toString();
  };
  const runs = gh([
    'run',
    'list',
    '--workflow',
    'ci.yml',
    '--branch',
    'master',
    '--event',
    'push',
    '--status',
    'success',
    '--limit',
    '1',
    '--json',
    'databaseId',
    '--jq',
    '.[0].databaseId',
  ]);
  const id = runs?.trim();
  if (!id) {
    console.error('No successful CI run on master found');
    return 1;
  }
  rmSync(MAP_DIR, { recursive: true, force: true });
  mkdirSync(MAP_DIR, { recursive: true });
  if (gh(['run', 'download', id, '--name', ARTIFACT, '--dir', MAP_DIR]) === null) return 1;
  for (const pkg of IMPACT_PACKAGES) {
    const map = loadMap(pkg);
    console.log(
      map
        ? `✓ ${pkg}: map of ${map.commit.slice(0, 8)} (${Object.keys(map.tests).length} test files)`
        : `✗ ${pkg}: no map in run ${id}`,
    );
  }
  return 0;
}

/**
 * Replays the last `commits` commits that touched the package or its
 * workspace dependencies and reports how many of the package's test files the
 * map would run for each, against the whole suite that package-level
 * selection runs.
 */
function evaluate(map: ImpactMap, commits: number): void {
  const total = Object.keys(map.tests).length;
  const universe = new Set([
    map.package,
    ...Object.values(map.tests)
      .flat()
      .map((f) => f.split('/').slice(0, 2).join('/')),
  ]);
  const log = lines(
    git(['log', '--format=%h', '-n', String(commits * 10), map.commit, '--', ...universe]),
  ).slice(0, commits);
  const timeOf = (tests: string[]) => tests.reduce((sum, t) => sum + (map.durationsMs[t] ?? 0), 0);
  const totalMs = timeOf(Object.keys(map.tests));
  let selectedMs = 0;
  let selectedSum = 0;
  let allCount = 0;
  let emptyCount = 0;
  const rows: string[] = [];
  for (const sha of log) {
    const changed = lines(
      git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]),
    ).filter((file) => [...universe].some((dir) => file.startsWith(`${dir}/`)));
    const selection = selectTests(map, changed);
    selectedSum += selection.tests.length;
    selectedMs += timeOf(selection.tests);
    if (selection.kind === 'all') allCount++;
    if (selection.tests.length <= Object.keys(map.alwaysRun).length) emptyCount++;
    const subject = git(['log', '-1', '--format=%s', sha]).trim().slice(0, 60);
    rows.push(
      `${sha}  ${String(selection.tests.length).padStart(4)}/${total}  ${selection.kind === 'all' ? `ALL (${selection.reason})` : ''} ${subject}`,
    );
  }
  console.log(rows.join('\n'));
  const avg = log.length ? selectedSum / log.length : 0;
  console.log(
    `\n${log.length} commits: on average ${avg.toFixed(1)} of ${total} test files (${((avg / total) * 100).toFixed(0)}%); ` +
      `${allCount} ran everything, ${emptyCount} ran only the always-run tests or none. ` +
      `Test time: ${((selectedMs / Math.max(1, log.length) / totalMs) * 100).toFixed(0)}% of the suite's ${(totalMs / 1000).toFixed(0)} s.`,
  );
}

function option(args: string[], name: string, fallback: string): string {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
}

function readMapFile(path: string): ImpactMap {
  const map: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isImpactMap(map)) throw new Error(`${path} is not a test-impact map`);
  return map;
}

if (import.meta.main) {
  const [command, target, ...rest] = process.argv.slice(2);
  if (command === 'fetch') {
    process.exit(fetchMaps());
  } else if (command === 'build' && target) {
    const pkgDir = target.replace(/\/$/, '');
    const jobs = Number(
      option(rest, '--jobs', String(Math.max(1, Math.floor(availableParallelism() / 2)))),
    );
    await build(pkgDir, resolve(option(rest, '--out', mapPathFor(pkgDir))), jobs);
  } else if (command === 'select' && target) {
    const selection = selectTests(readMapFile(target), rest);
    if (selection.kind === 'all') console.error(`Running everything: ${selection.reason}`);
    console.log(selection.tests.join('\n'));
  } else if (command === 'evaluate' && target) {
    evaluate(readMapFile(target), Number(option(rest, '--commits', '30')));
  } else {
    console.error('Usage: bun scripts/test-impact.ts fetch|build|select|evaluate …');
    process.exit(2);
  }
}
