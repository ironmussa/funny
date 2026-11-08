#!/usr/bin/env bun
// Fitness function: typecheck baseline diff.
//
// Runs bun check against each package and compares
// the error set against a frozen baseline at .fitness/typecheck-baseline.txt.
// Fails when there are NEW errors (i.e. errors present now that weren't in the
// baseline).
//
// Pre-existing errors stay in the baseline so the build doesn't break
// on day one — but every refactor must NOT add new errors.
//
// Usage:
//   bun run typecheck          # check against baseline (CI)
//   bun run typecheck:refresh  # rewrite baseline from current state
//   bun scripts/fitness/check-typecheck.ts --affected <files…>
//                              # pre-commit: only the projects those files can affect
//
// Projects run one after another: `bun check` already uses every core, so
// running several at once is no faster and only adds memory pressure.
//
// Why: a plain `bun run typecheck` that errors on every pre-existing
// failure is useless because nothing ever runs it. A baseline-diff makes
// the check meaningful AND keeps it green by default.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const BASELINE_PATH = join(ROOT, '.fitness', 'typecheck-baseline.txt');

// Each entry runs `bun check -p <project>`. Add new
// packages here as their own tsconfig.json gains errors worth gating on.
const PROJECTS = [
  'packages/client-core/tsconfig.json',
  'packages/client-benchmark/tsconfig.json',
  'packages/client-gpuix-benchmark/tsconfig.json',
  'packages/client-gpuix/tsconfig.json',
  'packages/gpuix-ui/tsconfig.json',
  'packages/ui-contracts/tsconfig.json',
  'scripts/renderer-benchmark/tsconfig.json',
  'packages/client/tsconfig.json',
  'packages/runtime/tsconfig.json',
  'packages/server/tsconfig.json',
  'packages/shared/tsconfig.json',
  'packages/harness/tsconfig.json',
  'packages/agent/tsconfig.json',
  'packages/sdk/tsconfig.json',
  'packages/scheduler/tsconfig.json',
];

const REFRESH = process.argv.includes('--refresh');

interface NormalizedError {
  /** Project-relative file path (e.g. "packages/client/src/.../foo.ts") */
  file: string;
  /** TS error code (e.g. "TS2304") */
  code: string;
  /** Single-line error message (multiline messages get joined with ' / ') */
  message: string;
}

/**
 * Run bun check for a single project and parse its error lines into normalized
 * (file, code, message) tuples. Line numbers are intentionally dropped —
 * adding a blank line above an existing error shouldn't count as a "new"
 * error.
 */
function checkEnv(): NodeJS.ProcessEnv {
  // Keep diagnostics stable when invoked from an agent session.
  const env = { ...process.env };
  delete env.AGENT;
  delete env.CLAUDECODE;
  delete env.REPL_ID;
  return env;
}

const CHECK_ARGS = (project: string) => ['check', '-p', project, '--pretty', 'false'];

/** Turn one `bun check` run into normalized errors, refusing incomplete runs. */
function interpretCheck(
  project: string,
  run: {
    stdout: string;
    stderr: string;
    status: number | null;
    signal?: string | null;
    error?: Error;
  },
): NormalizedError[] {
  const output = run.stdout + run.stderr;
  if (run.error || (run.status !== 0 && run.status !== 1)) {
    throw new Error(
      `bun check failed for ${project}: ${run.error?.message ?? run.signal ?? run.status}\n${output}`,
    );
  }
  // Configuration/global-type failures can stop checking before all files are visited.
  if (/^error TS\d+:|Stopped before/im.test(output)) {
    throw new Error(`bun check could not complete ${project}:\n${output}`);
  }
  const errors = parseDiagnostics(run.stdout, project, output);

  if (run.status !== 0 && errors.length === 0) {
    throw new Error(`bun check failed without parseable diagnostics for ${project}:\n${output}`);
  }
  return errors;
}

export function runTypecheck(project: string, cwd = ROOT): NormalizedError[] {
  const result = spawnSync(process.execPath, CHECK_ARGS(project), {
    cwd,
    env: checkEnv(),
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return interpretCheck(project, {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    signal: result.signal,
    error: result.error,
  });
}

// ── Affected projects (pre-commit) ─────────────────────────────

/** Files whose change can affect every project's types. */
const GLOBAL_INPUT = /(^|\/)(package\.json|bun\.lockb?|tsconfig[^/]*\.json)$|\.d\.ts$/;

/** `packages/<name>` for a repo-relative path inside a package, else null. */
function packageDirOf(file: string): string | null {
  const match = /^packages\/([^/]+)\//.exec(file);
  return match ? `packages/${match[1]}` : null;
}

interface Workspace {
  /** package dir → workspace package dirs it depends on directly */
  deps: Map<string, Set<string>>;
}

function readWorkspace(root: string): Workspace {
  const nameToDir = new Map<string, string>();
  const rawDeps = new Map<string, string[]>();
  const packagesDir = join(root, 'packages');
  for (const entry of existsSync(packagesDir) ? readdirSync(packagesDir) : []) {
    const manifest = join(packagesDir, entry, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf-8')) as Record<string, any>;
    const dir = `packages/${entry}`;
    if (typeof pkg.name === 'string') nameToDir.set(pkg.name, dir);
    rawDeps.set(
      dir,
      Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }),
    );
  }
  const deps = new Map<string, Set<string>>();
  for (const [dir, names] of rawDeps) {
    deps.set(
      dir,
      new Set(names.map((name) => nameToDir.get(name)).filter((d): d is string => !!d)),
    );
  }
  return { deps };
}

/** Package dirs a project's tsconfig reaches into directly (include, paths…). */
function tsconfigPackageRefs(root: string, project: string): Set<string> {
  const refs = new Set<string>();
  const projectDir = dirname(join(root, project));
  const text = readFileSync(join(root, project), 'utf-8');
  for (const match of text.matchAll(/"((?:\.\.?\/)[^"]*)"/g)) {
    const rel = relative(root, resolve(projectDir, match[1])).split(sep).join('/');
    const dir = packageDirOf(`${rel}/`);
    if (dir) refs.add(dir);
  }
  return refs;
}

/**
 * Projects whose result can change when `files` change: a project is affected
 * when a file lies in a package it is built from, directly or through workspace
 * dependencies (transitively). Anything that can change types globally, or a
 * file outside `packages/`, selects every project.
 */
export function selectAffectedProjects(
  files: readonly string[],
  projects: readonly string[] = PROJECTS,
  root = ROOT,
): string[] {
  const changedDirs = new Set<string>();
  for (const file of files) {
    const dir = packageDirOf(file);
    if (!dir || GLOBAL_INPUT.test(file)) return [...projects];
    changedDirs.add(dir);
  }
  const { deps } = readWorkspace(root);
  const reach = (start: Iterable<string>): Set<string> => {
    const seen = new Set<string>();
    const stack = [...start];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      if (seen.has(dir)) continue;
      seen.add(dir);
      for (const dep of deps.get(dir) ?? []) stack.push(dep);
    }
    return seen;
  };
  return projects.filter((project) => {
    const own = packageDirOf(project);
    // A project outside packages/ (scripts/…) has no package graph to trust.
    if (!own) return true;
    const inputs = reach([own, ...tsconfigPackageRefs(root, project)]);
    return [...inputs].some((dir) => changedDirs.has(dir));
  });
}

function normalizeDiagnostic(
  match: RegExpMatchArray,
  project: string,
  output: string,
): NormalizedError {
  const [, file, , , code, message] = match;
  // Syntax errors can prevent semantic checking; never freeze an incomplete run.
  if (file.endsWith('.json') || /^TS1\d{3}$/.test(code)) {
    throw new Error(`bun check could not complete ${project}:\n${output}`);
  }
  return { file, code, message };
}

function parseDiagnostics(stdout: string, project: string, output: string): NormalizedError[] {
  // Summaries and GitHub annotations must not become multiline error messages.
  const lines = stdout.split('\n');

  const errors: NormalizedError[] = [];
  let current: NormalizedError | null = null;

  for (const line of lines) {
    // Primary error pattern: "path/to/file.ts(123,45): error TS1234: message"
    const match = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if (match) {
      if (current) errors.push(current);
      current = normalizeDiagnostic(match, project, output);
      continue;
    }

    // Continuation lines (multiline error messages) start with whitespace
    if (current && /^\s+\S/.test(line)) {
      current.message += ' / ' + line.trim();
      continue;
    }

    // Anything else terminates the current error
    if (current) {
      errors.push(current);
      current = null;
    }
  }
  if (current) errors.push(current);

  return errors;
}

/** Stable string key for an error (used to build the baseline set). */
function errorKey(e: NormalizedError): string {
  return `${e.file}\t${e.code}\t${e.message}`;
}

function loadBaseline(): Set<string> {
  if (!existsSync(BASELINE_PATH)) return new Set();
  return new Set(
    readFileSync(BASELINE_PATH, 'utf-8')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#')),
  );
}

function writeBaseline(errors: NormalizedError[]): void {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  const sorted = errors.map(errorKey).sort();
  const header =
    '# typecheck baseline — generated by `bun run typecheck:refresh`\n' +
    '# Each line: <file>\\t<TS code>\\t<message>\n' +
    `# Last refreshed: ${new Date().toISOString()}\n` +
    `# Total errors: ${sorted.length}\n\n`;
  writeFileSync(BASELINE_PATH, header + sorted.join('\n') + '\n');
}

function selectedProjects(): string[] {
  const at = process.argv.indexOf('--affected');
  if (at === -1) return PROJECTS;
  const files = process.argv.slice(at + 1).filter((arg) => !arg.startsWith('--'));
  return selectAffectedProjects(files);
}

function main(): void {
  if (REFRESH && process.argv.includes('--affected')) {
    throw new Error('--refresh rewrites the whole baseline; it cannot be combined with --affected');
  }
  const projects = selectedProjects().filter((project) => {
    if (existsSync(join(ROOT, project))) return true;
    console.log(`  skipping ${project} (not found)`);
    return false;
  });
  if (projects.length === 0) {
    console.log('✓ No typechecked project is affected by these files');
    return;
  }
  console.log('Running bun check against', projects.length, 'projects…');
  const allErrors: NormalizedError[] = [];
  for (const project of projects) {
    process.stdout.write(`  ${project}… `);
    const errors = runTypecheck(project);
    console.log(`${errors.length} error(s)`);
    allErrors.push(...errors);
  }

  if (REFRESH) {
    writeBaseline(allErrors);
    console.log(`\n✓ Baseline refreshed: ${allErrors.length} error(s) frozen`);
    console.log(`  ${BASELINE_PATH}`);
    return;
  }

  const baseline = loadBaseline();
  const newErrors = allErrors.filter((e) => !baseline.has(errorKey(e)));

  if (newErrors.length === 0) {
    console.log(
      `\n✓ No new typecheck errors (baseline: ${baseline.size}, current: ${allErrors.length})`,
    );
    return;
  }

  console.error(`\n✗ ${newErrors.length} NEW typecheck error(s) since baseline:\n`);
  for (const e of newErrors) {
    console.error(`  ${e.file}: ${e.code}: ${e.message}`);
  }
  console.error(
    `\n  If these errors are intentional, refresh the baseline:\n    bun run typecheck:refresh\n`,
  );
  process.exit(1);
}

if (import.meta.main) main();
