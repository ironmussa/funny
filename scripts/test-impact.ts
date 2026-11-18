// Prototype: coverage-based test selection inside one `bun test` package.
//
// `scripts/run-tests.ts` selects whole packages (and, for vitest, `vitest
// related`). This script goes one level down for `bun test` packages: it
// records which source files each test file actually executes, then selects
// the test files whose recorded sources a change touches. Imports that a
// static graph cannot follow (dynamic `import()`, registries, DI) show up in
// the map because coverage sees what ran.
//
// Usage:
//   bun scripts/test-impact.ts build <packages/name> [--out map.json] [--jobs N]
//   bun scripts/test-impact.ts select <map.json> <changed files…>
//   bun scripts/test-impact.ts evaluate <map.json> [--commits N]
//
// `build` runs each test file alone with `--coverage --coverage-reporter=lcov`
// and the flags of the package's own `test` script. Paths in the map are
// repo-relative, so a change in another package (shared, core) selects the
// tests that executed it.
//
// Not wired into the pre-push hook or CI yet: the map would be built on main
// in CI and downloaded, and package-level selection stays as the safety net.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');

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
   * it saw no source file (the test reads sources as text, or tests only a
   * library), so the map cannot say what they depend on.
   */
  alwaysRun: Record<string, string>;
  /** Wall time of each test file's coverage run, to weigh selections by time. */
  durationsMs: Record<string, number>;
}

export type Selection =
  | { kind: 'all'; reason: string; tests: string[] }
  | { kind: 'some'; tests: string[] };

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** Source files coverage can see. Anything else in a package (JSON, SQL, fixtures, configs) can be read at runtime without coverage noticing. */
const CODE_FILE = /\.[cm]?[jt]sx?$/;

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
 * The test files to run for `changed` (repo-relative). A changed test file
 * selects itself. A change the map cannot judge (a non-code file in the
 * package, the package manifest or bunfig) selects everything. Tests in
 * `alwaysRun` are always selected.
 */
export function selectTests(map: ImpactMap, changed: readonly string[]): Selection {
  const all = Object.keys(map.tests).sort();
  const prefix = `${map.package}/`;
  const selected = new Set<string>(Object.keys(map.alwaysRun));
  const bySource = new Map<string, string[]>();
  for (const [test, sources] of Object.entries(map.tests)) {
    for (const source of sources) {
      const tests = bySource.get(source) ?? [];
      tests.push(test);
      bySource.set(source, tests);
    }
  }
  for (const file of changed) {
    if (file.startsWith(prefix) && !CODE_FILE.test(file)) {
      return { kind: 'all', reason: `${file} is not code coverage can see`, tests: all };
    }
    if (file.startsWith(prefix) && /\/(setup|preload)[^/]*\.[cm]?[jt]sx?$/.test(file)) {
      return { kind: 'all', reason: `${file} is a test setup file`, tests: all };
    }
    if (TEST_FILE.test(file)) {
      if (file in map.tests) selected.add(file);
      continue;
    }
    for (const test of bySource.get(file) ?? []) selected.add(test);
  }
  return { kind: 'some', tests: [...selected].sort() };
}

function git(args: string[], cwd = ROOT): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString();
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
        relative(absPkg, join(ROOT, test)),
      ],
      { cwd: absPkg, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, CI: '1' } },
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
  const tests = git(['ls-files', pkgDir])
    .split('\n')
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
  map.alwaysRun = Object.fromEntries(Object.entries(map.alwaysRun).sort());
  writeFileSync(out, `${JSON.stringify(map, null, 2)}\n`);
  console.error(
    `Wrote ${out}: ${tests.length} test files, ${Object.keys(map.alwaysRun).length} always run, ${(totalMs / 1000).toFixed(1)} s of test time`,
  );
}

/**
 * Replays the last `commits` commits that touched the package or its
 * workspace dependencies and reports how many of the package's test files the
 * map would run for each, against the whole suite that package-level
 * selection runs today.
 */
function evaluate(map: ImpactMap, commits: number): void {
  const total = Object.keys(map.tests).length;
  const universe = new Set([
    map.package,
    ...Object.values(map.tests)
      .flat()
      .map((f) => f.split('/').slice(0, 2).join('/')),
  ]);
  const log = git(['log', '--format=%h', '-n', String(commits * 10), map.commit, '--', ...universe])
    .split('\n')
    .filter(Boolean)
    .slice(0, commits);
  const timeOf = (tests: string[]) => tests.reduce((sum, t) => sum + (map.durationsMs[t] ?? 0), 0);
  const totalMs = timeOf(Object.keys(map.tests));
  let selectedMs = 0;
  let selectedSum = 0;
  let allCount = 0;
  let emptyCount = 0;
  const rows: string[] = [];
  for (const sha of log) {
    const changed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha])
      .split('\n')
      .filter(Boolean)
      .filter((file) => [...universe].some((dir) => file.startsWith(`${dir}/`)));
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

if (import.meta.main) {
  const [command, target, ...rest] = process.argv.slice(2);
  if (command === 'build' && target) {
    const name = target.replace(/\/$/, '').split('/').pop();
    const jobs = Number(
      option(rest, '--jobs', String(Math.max(1, Math.floor(availableParallelism() / 2)))),
    );
    await build(target.replace(/\/$/, ''), option(rest, '--out', `test-impact-${name}.json`), jobs);
  } else if (command === 'select' && target) {
    const selection = selectTests(JSON.parse(readFileSync(target, 'utf8')), rest);
    if (selection.kind === 'all') console.error(`Running everything: ${selection.reason}`);
    console.log(selection.tests.join('\n'));
  } else if (command === 'evaluate' && target) {
    evaluate(JSON.parse(readFileSync(target, 'utf8')), Number(option(rest, '--commits', '30')));
  } else {
    console.error('Usage: bun scripts/test-impact.ts build|select|evaluate …');
    process.exit(2);
  }
}
