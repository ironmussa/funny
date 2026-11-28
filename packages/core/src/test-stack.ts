/**
 * Deterministic test-stack detector (openspec factory-flow-bootstrap, D4).
 *
 * Inspects a repository checkout without a model and reports:
 * - package manager (by lockfile),
 * - monorepo / workspace layout (Nx, pnpm/bun/yarn/npm workspaces),
 * - test runner per package (jest, vitest, bun),
 * - test file patterns found in the repository,
 * - test files that appear to require external infrastructure (DB, containers, e2e).
 *
 * For stacks other than JS/TS (e.g. Python, Go, Rust), returns `recognized: false`
 * with a summary stating no test runner was recognized.
 */

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { parseStoredJson } from '@funny/shared/json-validation';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

export type DetectedPackageManager = 'pnpm' | 'bun' | 'yarn' | 'npm' | null;
export type DetectedMonorepo =
  | 'nx'
  | 'pnpm-workspaces'
  | 'bun-workspaces'
  | 'yarn-workspaces'
  | 'npm-workspaces'
  | null;
export type DetectedTestRunner = 'jest' | 'vitest' | 'bun' | null;

export interface DetectedTestPackage {
  name: string;
  /** Relative POSIX path from the checkout root (`"."` for the root package). */
  root: string;
  runner: DetectedTestRunner;
  /** Relative POSIX path to the runner config file, when one exists. */
  configFile: string | null;
  /** True when an Nx `project.json` in this package defines `targets.test`. */
  nxTestTarget: boolean;
  testPatterns: string[];
  /** Up to 5 non-infrastructure test files matched inside this package. */
  sampleTests: string[];
}

export interface DetectedInfraTest {
  path: string;
  reason: string;
}

export interface TestStackFacts {
  packageManager: DetectedPackageManager;
  monorepo: DetectedMonorepo;
  recognized: boolean;
  summary: string;
  packages: DetectedTestPackage[];
  testPatterns: string[];
  infrastructureTests: DetectedInfraTest[];
}

/** `TestStackFacts` as it crosses the runner → server boundary and sits in a stored column. */
export const testStackFactsSchema = z.object({
  packageManager: z.enum(['pnpm', 'bun', 'yarn', 'npm']).nullable(),
  monorepo: z
    .enum(['nx', 'pnpm-workspaces', 'bun-workspaces', 'yarn-workspaces', 'npm-workspaces'])
    .nullable(),
  recognized: z.boolean(),
  summary: z.string(),
  packages: z.array(
    z.object({
      name: z.string(),
      root: z.string(),
      runner: z.enum(['jest', 'vitest', 'bun']).nullable(),
      configFile: z.string().nullable(),
      nxTestTarget: z.boolean(),
      testPatterns: z.array(z.string()),
      sampleTests: z.array(z.string()),
    }),
  ),
  testPatterns: z.array(z.string()),
  infrastructureTests: z.array(z.object({ path: z.string(), reason: z.string() })),
}) satisfies z.ZodType<TestStackFacts>;

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.nx',
  '.turbo',
  '.cache',
  'coverage',
  'tmp',
  '.funny',
  '.venv',
  'venv',
  '__pycache__',
  'target',
]);

const MAX_WALKED_FILES = 15_000;
const MAX_SAMPLE_TESTS = 5;
const CONTENT_PEEK_BYTES = 4096;

const JEST_CONFIG_RE = /^jest\.config\.(?:[cm]?[jt]s|json)$/;
const VITEST_CONFIG_RE = /^vitest\.config\.[cm]?[jt]s$/;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

const INFRA_PATH_RULES: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\.e2e(?:-spec|\.spec|\.test)?\.[cm]?[jt]sx?$/i, reason: 'filename indicates e2e test' },
  {
    re: /\.integration(?:\.spec|\.test)?\.[cm]?[jt]sx?$/i,
    reason: 'filename indicates integration test',
  },
  {
    re: /(?:^|\/)(?:e2e|integration|integrations)\//i,
    reason: 'directory indicates integration/e2e',
  },
];

const INFRA_CONTENT_RULES: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /['"]@?testcontainers(?:\/[^'"]*)?['"]/, reason: 'uses testcontainers' },
  {
    re: /['"](?:pg|mysql2|mongodb|mongoose|ioredis|redis)['"]/,
    reason: 'imports database/cache client',
  },
  { re: /['"]@playwright\/test['"]|['"]playwright['"]/, reason: 'uses Playwright' },
  { re: /['"]supertest['"]/, reason: 'uses supertest' },
];

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

const packageJsonSchema = z
  .object({
    name: z.string().optional(),
    workspaces: z
      .union([z.array(z.string()), z.object({ packages: z.array(z.string()).optional() })])
      .optional(),
    scripts: z.record(z.string(), z.string()).optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

type ParsedPackageJson = z.infer<typeof packageJsonSchema>;

const nxProjectJsonSchema = z
  .object({
    name: z.string().optional(),
    targets: z
      .record(z.string(), z.object({ executor: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

type ParsedNxProjectJson = z.infer<typeof nxProjectJsonSchema>;

interface InferredRunner {
  runner: DetectedTestRunner;
  configFile: string | null;
}

/** Read a JSON file of the checkout through its schema; null when absent or not that shape. */
function readJsonFile<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  filePath: string,
): z.infer<TSchema> | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseStoredJson(schema, raw, filePath);
  return parsed.ok ? parsed.value : null;
}

function readPackageJson(filePath: string): ParsedPackageJson | null {
  return readJsonFile(packageJsonSchema, filePath);
}

function readNxProjectJson(filePath: string): ParsedNxProjectJson | null {
  return readJsonFile(nxProjectJsonSchema, filePath);
}

function peekFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8').slice(0, CONTENT_PEEK_BYTES);
  } catch {
    return '';
  }
}

function detectPackageManager(checkout: string): DetectedPackageManager {
  if (existsSync(join(checkout, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(checkout, 'bun.lock')) || existsSync(join(checkout, 'bun.lockb'))) {
    return 'bun';
  }
  if (existsSync(join(checkout, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(checkout, 'package-lock.json'))) return 'npm';
  return null;
}

function detectMonorepo(
  checkout: string,
  pm: DetectedPackageManager,
  rootPkg: ParsedPackageJson | null,
): DetectedMonorepo {
  if (existsSync(join(checkout, 'nx.json'))) return 'nx';
  if (existsSync(join(checkout, 'pnpm-workspace.yaml'))) return 'pnpm-workspaces';
  if (rootPkg?.workspaces) {
    if (pm === 'bun') return 'bun-workspaces';
    if (pm === 'yarn') return 'yarn-workspaces';
    if (pm === 'pnpm') return 'pnpm-workspaces';
    return 'npm-workspaces';
  }
  return null;
}

function readDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every file of the checkout outside `IGNORED_DIRS`, sorted, up to `MAX_WALKED_FILES`. */
function walkCheckout(checkout: string): string[] {
  const files: string[] = [];
  const stack: string[] = [checkout];
  while (stack.length > 0 && files.length < MAX_WALKED_FILES) {
    const dir = stack.pop()!;
    for (const entry of readDirEntries(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) stack.push(full);
      else if (entry.isFile()) files.push(toPosix(relative(checkout, full)));
      if (files.length >= MAX_WALKED_FILES) break;
    }
  }
  files.sort();
  return files;
}

function hasDep(pkg: ParsedPackageJson | null, name: string): boolean {
  if (!pkg) return false;
  return Boolean(
    pkg.devDependencies?.[name] !== undefined ||
    pkg.dependencies?.[name] !== undefined ||
    pkg.peerDependencies?.[name] !== undefined,
  );
}

function testScriptOf(pkg: ParsedPackageJson | null): string {
  return pkg?.scripts?.test ?? '';
}

const NO_CONFIG = null;

function runnerFromConfigFile(dirFiles: string[]): InferredRunner | null {
  const jestCfg = dirFiles.find((f) => JEST_CONFIG_RE.test(basename(f)));
  if (jestCfg) return { runner: 'jest', configFile: jestCfg };
  const vitestCfg = dirFiles.find((f) => VITEST_CONFIG_RE.test(basename(f)));
  if (vitestCfg) return { runner: 'vitest', configFile: vitestCfg };
  return null;
}

function runnerFromNxExecutor(projectJson: ParsedNxProjectJson | null): DetectedTestRunner {
  const executor = projectJson?.targets?.test?.executor ?? '';
  if (executor.includes('jest')) return 'jest';
  if (executor.includes('vite') || executor.includes('vitest')) return 'vitest';
  return null;
}

function runnerFromScript(script: string): DetectedTestRunner {
  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b/.test(script)) return 'jest';
  if (/\bbun\s+test\b/.test(script)) return 'bun';
  return null;
}

function runnerFromDeps(pkg: ParsedPackageJson | null): DetectedTestRunner {
  if (hasDep(pkg, 'vitest')) return 'vitest';
  if (hasDep(pkg, 'jest') || hasDep(pkg, '@jest/globals')) return 'jest';
  return null;
}

/** The repository root's runner, which a package without its own falls back to. */
function runnerFromRoot(
  absRoot: string,
  rootPkgJson: ParsedPackageJson | null,
  pm: DetectedPackageManager,
): DetectedTestRunner {
  const rootScript = testScriptOf(rootPkgJson);
  if (/\bvitest\b/.test(rootScript) || hasDep(rootPkgJson, 'vitest')) return 'vitest';
  if (/\bjest\b/.test(rootScript) || hasDep(rootPkgJson, 'jest')) return 'jest';
  const bunRoot =
    pm === 'bun' || /\bbun\s+test\b/.test(rootScript) || existsSync(join(absRoot, 'bunfig.toml'));
  return bunRoot ? 'bun' : null;
}

/** A package's runner, from the most to the least specific evidence. */
function inferRunner(
  absRoot: string,
  dirFiles: string[],
  pkgJson: ParsedPackageJson | null,
  rootPkgJson: ParsedPackageJson | null,
  projectJson: ParsedNxProjectJson | null,
  pm: DetectedPackageManager,
): InferredRunner {
  const fromConfig = runnerFromConfigFile(dirFiles);
  if (fromConfig) return fromConfig;
  const runner =
    runnerFromNxExecutor(projectJson) ??
    runnerFromScript(testScriptOf(pkgJson)) ??
    runnerFromDeps(pkgJson) ??
    runnerFromRoot(absRoot, rootPkgJson, pm);
  return { runner, configFile: NO_CONFIG };
}

function infraReason(checkout: string, relPath: string): string | null {
  for (const rule of INFRA_PATH_RULES) {
    if (rule.re.test(relPath)) return rule.reason;
  }
  const content = peekFile(join(checkout, relPath));
  for (const rule of INFRA_CONTENT_RULES) {
    if (rule.re.test(content)) return rule.reason;
  }
  return null;
}

function patternOfTestFile(relPath: string): string {
  const match = relPath.match(/\.(test|spec)\.([cm]?[jt]sx?)$/);
  return match ? `**/*.${match[1]}.${match[2]}` : '**/*.test.ts';
}

function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '.' : relPath.slice(0, idx);
}

interface CheckoutIndex {
  files: string[];
  /** Directories holding a `package.json` or `project.json`. */
  pkgRoots: Set<string>;
  dirToFiles: Map<string, string[]>;
}

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function indexCheckout(files: string[]): CheckoutIndex {
  const pkgRoots = new Set<string>();
  const dirToFiles = new Map<string, string[]>();
  for (const f of files) {
    const d = dirOf(f);
    pushTo(dirToFiles, d, f);
    const name = basename(f);
    if (name === 'package.json' || name === 'project.json') pkgRoots.add(d);
  }
  return { files, pkgRoots, dirToFiles };
}

interface ClassifiedTests {
  testsByPkg: Map<string, string[]>;
  infrastructureTests: DetectedInfraTest[];
  allPatterns: Set<string>;
}

/** Each test file goes to its deepest package, or to the infrastructure list. */
function classifyTests(checkout: string, index: CheckoutIndex): ClassifiedTests {
  const deepestFirst = [...index.pkgRoots].sort((a, b) => {
    if (a === '.') return 1;
    if (b === '.') return -1;
    return b.length - a.length || a.localeCompare(b);
  });
  const classified: ClassifiedTests = {
    testsByPkg: new Map(),
    infrastructureTests: [],
    allPatterns: new Set(),
  };
  for (const f of index.files) {
    if (!TEST_FILE_RE.test(f)) continue;
    classified.allPatterns.add(patternOfTestFile(f));
    const reason = infraReason(checkout, f);
    if (reason) {
      classified.infrastructureTests.push({ path: f, reason });
      continue;
    }
    const owner =
      deepestFirst.find((root) => root === '.' || f === root || f.startsWith(`${root}/`)) ?? '.';
    pushTo(classified.testsByPkg, owner, f);
  }
  return classified;
}

interface StackContext {
  checkout: string;
  index: CheckoutIndex;
  tests: ClassifiedTests;
  rootPkg: ParsedPackageJson | null;
  packageManager: DetectedPackageManager;
  monorepo: DetectedMonorepo;
  rootCount: number;
}

/** Whether a package root adds nothing a member could run tests with. */
function isEmptyPackage(
  ctx: StackContext,
  root: string,
  pkg: Pick<DetectedTestPackage, 'runner' | 'configFile' | 'nxTestTarget' | 'sampleTests'>,
  hasProjectJson: boolean,
): boolean {
  const noTestsOrConfig = pkg.sampleTests.length === 0 && !pkg.configFile;
  // A monorepo's root package only aggregates its members.
  const isAggregatingRoot = root === '.' && ctx.monorepo !== null && ctx.rootCount > 1;
  if (isAggregatingRoot && noTestsOrConfig && !pkg.nxTestTarget) return true;
  if (hasProjectJson && !pkg.nxTestTarget && noTestsOrConfig) return true;
  return !pkg.runner && !pkg.nxTestTarget && pkg.sampleTests.length === 0;
}

function describePackage(ctx: StackContext, root: string): DetectedTestPackage | null {
  const absRoot = root === '.' ? ctx.checkout : join(ctx.checkout, root);
  const pkgJson = readPackageJson(join(absRoot, 'package.json'));
  const projectJson = readNxProjectJson(join(absRoot, 'project.json'));
  const ownTests = ctx.tests.testsByPkg.get(root) ?? [];
  const { runner, configFile } = inferRunner(
    absRoot,
    ctx.index.dirToFiles.get(root) ?? [],
    pkgJson,
    ctx.rootPkg,
    projectJson,
    ctx.packageManager,
  );
  const pkg = {
    runner,
    configFile,
    nxTestTarget: Boolean(projectJson?.targets?.test),
    sampleTests: ownTests.slice(0, MAX_SAMPLE_TESTS),
  };
  if (isEmptyPackage(ctx, root, pkg, projectJson !== null)) return null;

  const infraPaths = ctx.tests.infrastructureTests.flatMap((i) =>
    root === '.' || i.path.startsWith(`${root}/`) ? [i.path] : [],
  );
  const testPatterns = [...new Set(ownTests.concat(infraPaths).map(patternOfTestFile))].sort();
  return { name: projectJson?.name || pkgJson?.name || root, root, ...pkg, testPatterns };
}

function summarize(
  packageManager: DetectedPackageManager,
  monorepo: DetectedMonorepo,
  packages: DetectedTestPackage[],
): string {
  const runners = [...new Set(packages.flatMap((p) => (p.runner ? [p.runner] : [])))];
  return [
    packageManager ? `package manager: ${packageManager}` : 'package manager: unknown',
    monorepo ? `monorepo: ${monorepo}` : 'single package',
    `packages with tests: ${packages.length}`,
    `runners: ${runners.join(', ')}`,
  ].join('; ');
}

function checkCheckoutDir(checkout: string): Result<void, DomainError> {
  try {
    if (!existsSync(checkout) || !statSync(checkout).isDirectory()) {
      return err(badRequest(`Checkout directory does not exist: ${checkout}`));
    }
    return ok(undefined);
  } catch (cause) {
    return err(internal(`Failed to inspect checkout: ${String(cause)}`));
  }
}

/**
 * Inspect `checkout` and return deterministic facts about its test stack.
 */
export function detectTestStack(checkout: string): Result<TestStackFacts, DomainError> {
  const valid = checkCheckoutDir(checkout);
  if (valid.isErr()) return err(valid.error);

  const index = indexCheckout(walkCheckout(checkout));
  const rootPkg = readPackageJson(join(checkout, 'package.json'));
  const packageManager = detectPackageManager(checkout);
  const monorepo = detectMonorepo(checkout, packageManager, rootPkg);
  const tests = classifyTests(checkout, index);
  const ctx: StackContext = {
    checkout,
    index,
    tests,
    rootPkg,
    packageManager,
    monorepo,
    rootCount: index.pkgRoots.size,
  };

  const rootsInOrder = [...index.pkgRoots].sort((a, b) =>
    a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b),
  );
  const packages = rootsInOrder.flatMap((root) => describePackage(ctx, root) ?? []);
  const recognized = packages.some((p) => p.runner !== null);

  return ok({
    packageManager,
    monorepo,
    recognized,
    summary: recognized
      ? summarize(packageManager, monorepo, packages)
      : 'No test runner recognized in this repository.',
    packages,
    testPatterns: [...tests.allPatterns].sort(),
    infrastructureTests: tests.infrastructureTests,
  });
}
