/**
 * @domain subdomain: Agent Checks
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: domain
 *
 * Which command runs a check (`test`, `typecheck`, `lint`, `format`, `build`,
 * `verify`) in a working directory, from its manifests: a project script for
 * the kind first (unless a scope or filter needs the tool itself), then a
 * known tool in the dependencies run with the lockfile's package manager, then
 * the language default (`pytest`, `cargo`, `go`). funny's own runners
 * (`bun run test` → `scripts/run-tests.ts`, `bun run steps <task>`) write their
 * progress file themselves when given its path; every other plan is followed
 * by parsing its output.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  classifyCheckCommand,
  scriptKind,
  type CheckKind,
  type CheckTool,
} from '@funny/shared/checks';
import { parseStoredJson } from '@funny/shared/json-validation';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

export interface CheckRequest {
  kind: CheckKind;
  /** Files, directories, packages or test patterns. */
  scope?: string[];
  /** A test name. */
  filter?: string;
  /** An exact command; runs as given. */
  command?: string;
}

export interface CheckStep {
  /** Label in the widget and summary. */
  name: string;
  /** Shell command, run with `bash -c` in the plan's cwd. */
  command: string;
  tool: CheckTool | 'unknown';
}

export interface CheckPlan {
  kind: CheckKind;
  cwd: string;
  /** `test` follows a test-progress run; the other kinds a task-progress run. */
  progress: 'test' | 'task';
  /** Test plans have one step; task plans run their steps in order. */
  steps: CheckStep[];
  /**
   * The command writes the progress file itself when this env var names it
   * (funny's own runners); otherwise the runner parses its output.
   */
  progressEnv?: 'FUNNY_TEST_PROGRESS' | 'FUNNY_TASK_PROGRESS';
  /** Added for vitest steps, so the runner can pass its reporter. */
  vitest?: boolean;
  /** Added for plain tsc steps, so the runner can ask for `--diagnostics` (files and lines checked). */
  tscDiagnostics?: boolean;
  /** Notes for the agent, e.g. a filter the tool cannot apply. */
  notes: string[];
}

export interface CheckPlanError {
  kind: 'not-detected';
  message: string;
}

type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

const packageJsonSchema = z
  .object({
    scripts: z.record(z.string(), z.string()).optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
  })
  .loose();

type PackageJson = z.infer<typeof packageJsonSchema>;

/** What a directory declares, read once per plan. */
interface Project {
  cwd: string;
  pkg: PackageJson | null;
  pm: PackageManager;
  deps: Set<string>;
  python: string | null;
  cargo: boolean;
  go: boolean;
}

const LOCKFILES: [string, PackageManager][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

/** Parent levels searched for a lockfile (a workspace package's root). */
const LOCK_DEPTH = 4;

function readPackageJson(path: string): PackageJson | null {
  const raw = readText(path);
  if (raw === null) return null;
  const parsed = parseStoredJson(packageJsonSchema, raw, 'package.json');
  return parsed.ok ? parsed.value : null;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function packageManager(cwd: string): PackageManager {
  let dir = cwd;
  for (let level = 0; level <= LOCK_DEPTH; level++) {
    for (const [file, pm] of LOCKFILES) if (existsSync(join(dir, file))) return pm;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'npm';
}

function readProject(cwd: string): Project {
  const pkg = readPackageJson(join(cwd, 'package.json'));
  const deps = new Set([
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
  ]);
  const python = ['pyproject.toml', 'setup.cfg', 'pytest.ini', 'tox.ini']
    .map((file) => readText(join(cwd, file)))
    .filter((text): text is string => text !== null)
    .join('\n');
  return {
    cwd,
    pkg,
    pm: pkg ? packageManager(cwd) : 'npm',
    deps,
    python: python || (existsSync(join(cwd, 'requirements.txt')) ? '' : null),
    cargo: existsSync(join(cwd, 'Cargo.toml')),
    go: existsSync(join(cwd, 'go.mod')),
  };
}

const quote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
const args = (list: (string | undefined | false)[]) =>
  list
    .filter((arg): arg is string => Boolean(arg))
    .map(quote)
    .join(' ');

/**
 * Files or directories the check runs on. A glob (`src/*.test.ts`) stays
 * unquoted so the shell expands it, as it would in the agent's own Bash call;
 * anything else unsafe is quoted like any argument.
 */
const pathArg = (arg: string) => (/^[\w@%+=:,./*?-]+$/.test(arg) ? arg : quote(arg));
const paths = (list: string[]) => list.map(pathArg).join(' ');

/** Parts joined by spaces, skipping empty ones (no scope, no filter). */
const spaced = (...parts: string[]) => parts.filter(Boolean).join(' ');

const runScript = (pm: PackageManager, script: string, extra: string[] = []) =>
  [pm === 'npm' ? 'npm run' : `${pm} run`, quote(script), extra.length ? `-- ${paths(extra)}` : '']
    .filter(Boolean)
    .join(' ');

/** How the package manager runs a dependency's binary. */
const BIN: Record<PackageManager, string> = {
  bun: 'bunx',
  pnpm: 'pnpm exec',
  yarn: 'yarn',
  npm: 'npx',
};

/** Script names tried for a kind, in order. */
const SCRIPT_NAMES: Record<CheckKind, string[]> = {
  test: ['test', 'test:unit', 'tests'],
  typecheck: ['typecheck', 'type-check', 'check-types', 'types', 'tsc'],
  lint: ['lint'],
  format: ['format', 'fmt'],
  build: ['build'],
  verify: ['verify', 'ci'],
};

function findScript(project: Project, kind: CheckKind): string | null {
  const scripts = project.pkg?.scripts ?? {};
  const named = SCRIPT_NAMES[kind].find((name) => scripts[name]);
  if (named) return named;
  return (
    Object.keys(scripts).find((name) => scriptKind(name) === kind && !name.includes(':')) ?? null
  );
}

/** funny's own runners, which write the progress file themselves. */
function selfReporting(
  project: Project,
  kind: CheckKind,
  script: string,
): CheckPlan['progressEnv'] {
  const body = project.pkg?.scripts?.[script] ?? '';
  if (kind === 'test' && /scripts\/run-tests\.ts/.test(body)) return 'FUNNY_TEST_PROGRESS';
  return undefined;
}

function plan(
  project: Project,
  kind: CheckKind,
  steps: CheckStep[],
  extra: Partial<CheckPlan> = {},
): CheckPlan {
  return {
    kind,
    cwd: project.cwd,
    progress: kind === 'test' ? 'test' : 'task',
    steps,
    notes: [],
    ...extra,
  };
}

/** `uv run ` when the project uses uv, `poetry run ` with poetry, else nothing. */
function pythonRunner(project: Project): string {
  if (existsSync(join(project.cwd, 'uv.lock'))) return 'uv run ';
  if (existsSync(join(project.cwd, 'poetry.lock'))) return 'poetry run ';
  return '';
}

/** A tool that can run a kind of check, when the project has it. */
interface Candidate {
  tool: CheckTool;
  has: (project: Project) => boolean;
  /** The command, from the project's runner prefix, scope (or `.`) and filter. */
  command: (run: {
    bin: string;
    py: string;
    scope: string[];
    targets: string[];
    filter?: string;
  }) => string;
}

const dep = (name: string) => (project: Project) => project.deps.has(name);
const pythonWith =
  (...names: string[]) =>
  (project: Project) =>
    project.python !== null &&
    names.some(
      (name) => project.python!.includes(name) || existsSync(join(project.cwd, `${name}.toml`)),
    );
const hasCargo = (project: Project) => project.cargo;
const hasGo = (project: Project) => project.go;
const named = (flag: string, filter?: string) => (filter ? [flag, filter] : []);

/** A package binary run on the scope (or `.`): `bunx eslint src`. */
const binOnTargets = (tool: CheckTool, pkg: string, command: string): Candidate => ({
  tool,
  has: dep(pkg),
  command: (r) => `${r.bin} ${command} ${paths(r.targets)}`,
});

/** A Python tool the project configures, run on the scope (or `.`). */
const pythonOnTargets = (tool: CheckTool, command: string): Candidate => ({
  tool,
  has: pythonWith(tool),
  command: (r) => `${r.py}${command} ${paths(r.targets)}`,
});

const fixed = (tool: CheckTool, has: Candidate['has'], command: string): Candidate => ({
  tool,
  has,
  command: () => command,
});

/** Tools per kind, in order of preference. */
const CANDIDATES: Partial<Record<CheckKind, Candidate[]>> = {
  test: [
    {
      tool: 'vitest',
      has: dep('vitest'),
      command: (r) => `${r.bin} vitest run ${spaced(paths(r.scope), args(named('-t', r.filter)))}`,
    },
    {
      tool: 'jest',
      has: dep('jest'),
      command: (r) => `${r.bin} jest ${spaced(paths(r.scope), args(named('-t', r.filter)))}`,
    },
    {
      tool: 'playwright',
      has: dep('@playwright/test'),
      command: (r) =>
        `${r.bin} playwright test ${spaced(paths(r.scope), args(named('--grep', r.filter)))}`,
    },
    {
      tool: 'bun-test',
      has: (project) => Boolean(project.pkg) && project.pm === 'bun',
      command: (r) => `bun test ${spaced(paths(r.scope), args(named('-t', r.filter)))}`,
    },
    {
      tool: 'pytest',
      has: (project) => project.python !== null,
      command: (r) => `${r.py}pytest ${spaced(paths(r.scope), args(named('-k', r.filter)))}`,
    },
    {
      tool: 'cargo',
      has: hasCargo,
      command: (r) => `cargo test ${args([...r.scope.flatMap((s) => ['-p', s]), r.filter])}`,
    },
    {
      tool: 'go',
      has: hasGo,
      command: (r) =>
        `go test ${spaced(paths(r.scope.length ? r.scope : ['./...']), args(named('-run', r.filter)))}`,
    },
  ],
  typecheck: [
    {
      tool: 'tsc',
      has: (project) =>
        project.deps.has('typescript') && existsSync(join(project.cwd, 'tsconfig.json')),
      command: (r) => `${r.bin} tsc --noEmit ${r.scope[0] ? `-p ${quote(r.scope[0])}` : ''}`,
    },
    pythonOnTargets('mypy', 'mypy'),
    fixed('cargo', hasCargo, 'cargo check'),
    fixed('go', hasGo, 'go vet ./...'),
  ],
  lint: [
    { tool: 'oxlint', has: dep('oxlint'), command: (r) => `${r.bin} oxlint ${paths(r.scope)}` },
    binOnTargets('eslint', 'eslint', 'eslint'),
    binOnTargets('biome', '@biomejs/biome', 'biome lint'),
    pythonOnTargets('ruff', 'ruff check'),
    fixed('cargo', hasCargo, 'cargo clippy'),
    fixed('go', hasGo, 'go vet ./...'),
  ],
  format: [
    binOnTargets('oxfmt', 'oxfmt', 'oxfmt --write'),
    binOnTargets('prettier', 'prettier', 'prettier --write'),
    binOnTargets('biome', '@biomejs/biome', 'biome format --write'),
    pythonOnTargets('ruff', 'ruff format'),
    fixed('cargo', hasCargo, 'cargo fmt'),
    { tool: 'go', has: hasGo, command: (r) => `gofmt -l -w ${args(r.targets)}` },
  ],
  build: [fixed('cargo', hasCargo, 'cargo build'), fixed('go', hasGo, 'go build ./...')],
};

/** The first tool the project has for `kind`, as a step; null when none fits. */
function toolStep(
  project: Project,
  kind: CheckKind,
  scope: string[],
  filter?: string,
): CheckStep | null {
  const candidate = CANDIDATES[kind]?.find((c) => c.has(project));
  if (!candidate) return null;
  const run = {
    bin: BIN[project.pm],
    py: pythonRunner(project),
    scope,
    targets: scope.length ? scope : ['.'],
    filter,
  };
  return { name: candidate.tool, command: candidate.command(run).trim(), tool: candidate.tool };
}

/** What the runner adds to a tool it runs directly: vitest's reporter, tsc's diagnostics. */
function toolExtra(tool: CheckStep['tool']): Partial<CheckPlan> {
  if (tool === 'vitest') return { vitest: true };
  if (tool === 'tsc') return { tscDiagnostics: true };
  return {};
}

/** A plan that runs one tool directly. */
function toolPlan(
  project: Project,
  kind: CheckKind,
  scope: string[],
  filter?: string,
): CheckPlan | null {
  const step = toolStep(project, kind, scope, filter);
  if (!step) return null;
  return plan(project, kind, [step], toolExtra(step.tool));
}

/** What was looked for, for the "nothing detected" error. */
function lookedFor(project: Project, kind: CheckKind): string {
  const manifests = [
    project.pkg && 'package.json',
    project.python !== null && 'pyproject.toml',
    project.cargo && 'Cargo.toml',
    project.go && 'go.mod',
  ].filter(Boolean);
  const found = manifests.length
    ? `found ${manifests.join(', ')}`
    : 'found no package.json, pyproject.toml, Cargo.toml or go.mod';
  return `No ${kind} command detected in ${project.cwd} (${found}; looked for a "${SCRIPT_NAMES[kind].join('" / "')}" script and a known ${kind} tool). Pass "command" to run one.`;
}

const runCommand = (pm: PackageManager) => (pm === 'npm' ? 'npm run' : `${pm} run`);

/** A plan that runs the project's script for the kind. */
function scriptPlan(
  project: Project,
  kind: CheckKind,
  script: string,
  request: CheckRequest,
): CheckPlan {
  const scope = request.scope ?? [];
  const body = project.pkg?.scripts?.[script] ?? '';
  const progressEnv = selfReporting(project, kind, script);
  const inner = classifyCheckCommand(body);
  const extra: Partial<CheckPlan> = {};
  if (progressEnv) extra.progressEnv = progressEnv;
  else if (inner?.tool === 'vitest' && inner.plain) extra.vitest = true;
  if (request.filter)
    extra.notes = [
      `The "${script}" script cannot take a test-name filter; ignored "${request.filter}".`,
    ];
  return plan(
    project,
    kind,
    [{ name: script, command: runScript(project.pm, script, scope), tool: 'script' }],
    extra,
  );
}

/** funny's `bun run steps <task>`: the task's parts as steps, with their own progress. */
function stepsPlan(project: Project, kind: CheckKind, scope: string[]): CheckPlan | null {
  const stepsKinds: CheckKind[] = ['lint', 'typecheck', 'build', 'verify'];
  if (!project.pkg?.scripts?.steps || !stepsKinds.includes(kind) || scope.length) return null;
  return plan(
    project,
    kind,
    [{ name: kind, command: `${runCommand(project.pm)} steps ${kind}`, tool: 'script' }],
    {
      progressEnv: 'FUNNY_TASK_PROGRESS',
    },
  );
}

/**
 * The plan for one kind, or null: a scope or filter needs the tool itself
 * (scripts cannot take them reliably); otherwise the project's own runner or
 * script, then the tool.
 */
function kindPlan(project: Project, request: CheckRequest): CheckPlan | null {
  const { kind, scope = [], filter } = request;
  const narrowed = scope.length > 0 || Boolean(filter);
  const direct = narrowed ? toolPlan(project, kind, scope, filter) : null;
  if (direct) return direct;
  const steps = stepsPlan(project, kind, scope);
  if (steps) return steps;
  const script = findScript(project, kind);
  if (script) return scriptPlan(project, kind, script, request);
  return toolPlan(project, kind, scope, filter);
}

/** `verify`: the project's own runner or script, else lint + typecheck + test in one task. */
function verifyPlan(project: Project, request: CheckRequest): CheckPlan | null {
  const own = stepsPlan(project, 'verify', request.scope ?? []);
  if (own) return own;
  const script = findScript(project, 'verify');
  if (script) return scriptPlan(project, 'verify', script, request);
  const parts = (['lint', 'typecheck', 'test'] as const)
    .map((kind) => kindPlan(project, { ...request, kind }))
    .filter((part): part is CheckPlan => part !== null);
  if (!parts.length) return null;
  return plan(
    project,
    'verify',
    parts.flatMap((part) => part.steps),
    {
      notes: parts.flatMap((part) => part.notes),
      ...(parts.some((part) => part.vitest) ? { vitest: true } : {}),
      ...(parts.some((part) => part.tscDiagnostics) ? { tscDiagnostics: true } : {}),
    },
  );
}

const UNRECOGNISED =
  'The command is not a recognised check; only its exit code and output tail are reported.';

/** A plan for an exact command: instrumented when it is a recognised check. */
function commandPlan(project: Project, request: CheckRequest, command: string): CheckPlan {
  const check = classifyCheckCommand(command);
  if (!check) {
    return plan(project, request.kind, [{ name: request.kind, command, tool: 'unknown' }], {
      notes: [UNRECOGNISED],
    });
  }
  const step: CheckStep = { name: check.script ?? check.tool, command, tool: check.tool };
  return plan(project, check.kind, [step], check.plain ? toolExtra(check.tool) : {});
}

/** The plan for `request` in `cwd`, or why none was found. */
export function planCheck(cwd: string, request: CheckRequest): Result<CheckPlan, CheckPlanError> {
  const project = readProject(cwd);
  if (request.command) return ok(commandPlan(project, request, request.command));
  const found =
    request.kind === 'verify' ? verifyPlan(project, request) : kindPlan(project, request);
  return found
    ? ok(found)
    : err({ kind: 'not-detected', message: lookedFor(project, request.kind) });
}
