// Recognises a shell command as a check (tests, type check, lint, format,
// build) and which tool runs it, from the command text alone. Shared by the
// runtime (which tool to instrument, whether to redirect a raw Bash call to
// `funny_run_checks`) and the client (whether a Bash card shows a check
// result).
//
// `plain` marks a command that is only the check: optionally `cd <dir> &&`
// and env assignments first, `2>&1` at most, nothing piped or chained. Only a
// plain command is safe to redirect: anything else may depend on the shell
// around the check.

export type CheckKind = 'test' | 'typecheck' | 'lint' | 'format' | 'build' | 'verify';

export type CheckTool =
  | 'vitest'
  | 'bun-test'
  | 'jest'
  | 'playwright'
  | 'pytest'
  | 'cargo'
  | 'go'
  | 'tsc'
  | 'mypy'
  | 'pyright'
  | 'oxlint'
  | 'eslint'
  | 'ruff'
  | 'biome'
  | 'oxfmt'
  | 'prettier'
  /** A package.json script (`npm run lint`, `bun run test`, `pnpm typecheck`). */
  | 'script';

export interface CheckCommand {
  kind: CheckKind;
  tool: CheckTool;
  plain: boolean;
  /** The directory of a leading `cd <dir> &&`. */
  cwd?: string;
  /** Files, directories or packages named on the command line. */
  scope: string[];
  /** A test-name filter (`-t`, `-k`, `--grep`, `-run`). */
  filter?: string;
  /** The script name, for `tool: 'script'`. */
  script?: string;
}

/** Package runners whose next word is the tool. */
const RUNNERS: Record<string, number> = {
  npx: 1,
  bunx: 1,
  uvx: 1,
  'pipx run': 2,
  'pnpm exec': 2,
  'pnpm dlx': 2,
  'npm exec': 2,
  'yarn exec': 2,
  'uv run': 2,
  'poetry run': 2,
  'python -m': 2,
  'python3 -m': 2,
};

/** Script-running package managers: `<pm> run <script>`; pnpm and yarn also `<pm> <script>`. */
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** A script's kind from its name; null for scripts that are not checks. */
export function scriptKind(name: string): CheckKind | null {
  const base = name.toLowerCase();
  const has = (re: RegExp) => base.split(':').some((part) => re.test(part));
  if (has(/^(typecheck|type-check|types|tsc|check-types|typecheck-\w+)$/)) return 'typecheck';
  if (has(/^(test|tests|spec|e2e|vitest|jest|pytest|test-\w+)$/)) return 'test';
  if (has(/^(lint|eslint|oxlint|lint-\w+)$/)) return 'lint';
  if (has(/^(format|fmt|prettier|format-check)$/)) return 'format';
  if (has(/^(build|compile)$/)) return 'build';
  if (has(/^(verify|ci|check-all)$/)) return 'verify';
  return null;
}

/** Splits on unquoted whitespace; quotes are dropped. */
function words(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Shell syntax that makes a command more than one check. */
const COMPOUND = /\||;|&&|\$\(|`|>(?!&1)|<|\n/;

/** The command after a leading `cd <dir> &&`, env assignments and `time` / `timeout N`. */
function stripPrefix(command: string): { cwd?: string; rest: string } {
  let rest = command.trim();
  let cwd: string | undefined;
  const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/.exec(rest);
  if (cd) {
    cwd = cd[1].replace(/^["']|["']$/g, '');
    rest = rest.slice(cd[0].length);
  }
  rest = rest.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  rest = rest.replace(/^(?:time|timeout\s+\d+[smh]?)\s+/, '');
  return { cwd, rest };
}

/** Value of the first flag in `flags` (`-t name`, `-t=name`, `--grep=name`). */
function flagValue(args: string[], flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    for (const flag of flags) {
      if (args[i] === flag) return args[i + 1];
      if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
    }
  }
  return undefined;
}

/** Positional arguments, skipping flags and the values of `valued` flags. */
function positionals(args: string[], valued: string[], skip: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '2>&1' || arg === '--') continue;
    if (arg.startsWith('-')) {
      if (valued.includes(arg)) i++;
      continue;
    }
    if (!skip.includes(arg)) out.push(arg);
  }
  return out;
}

const TEST_NAME_FLAGS: Partial<Record<CheckTool, string[]>> = {
  vitest: ['-t', '--testNamePattern'],
  jest: ['-t', '--testNamePattern'],
  'bun-test': ['-t', '--test-name-pattern'],
  playwright: ['-g', '--grep'],
  pytest: ['-k'],
  go: ['-run'],
};

/** Flags whose next word is their value, not a positional. */
const VALUED = [
  '-t',
  '-k',
  '-g',
  '-p',
  '-c',
  '--grep',
  '--project',
  '--config',
  '--reporter',
  '-run',
  '--testNamePattern',
  '--test-name-pattern',
  '--timeout',
  '--max-warnings',
  '--format',
  '-f',
];

function check(
  kind: CheckKind,
  tool: CheckTool,
  args: string[],
  skip: string[] = [],
): Omit<CheckCommand, 'plain' | 'cwd'> {
  const names = TEST_NAME_FLAGS[tool];
  const filter = names ? flagValue(args, names) : undefined;
  return { kind, tool, scope: positionals(args, VALUED, skip), ...(filter ? { filter } : {}) };
}

/** Words to drop before the tool: `npx`, `pnpm exec`, `uv run`, pnpm / yarn's `<pm> <bin>`. */
function runnerWords(argv: string[]): number {
  const skip = RUNNERS[`${argv[0]} ${argv[1] ?? ''}`] ?? RUNNERS[argv[0]];
  if (skip) return skip;
  if (argv[0] !== 'pnpm' && argv[0] !== 'yarn') return 0;
  return argv[1] === 'dlx' ? 2 : 1;
}

/** The tool and its arguments, after any package runner. */
function toolOf(argv: string[]): { name: string; args: string[] } | null {
  if (!argv[0]) return null;
  const bare = [argv[0].replace(/^(?:\.\/)?node_modules\/\.bin\//, ''), ...argv.slice(1)];
  let rest = bare.slice(runnerWords(bare));
  // npx flags (`npx -y vitest`) come before the tool.
  while (rest[0]?.startsWith('-')) rest = rest.slice(1);
  return rest[0] ? { name: rest[0], args: rest.slice(1) } : null;
}

type Found = Omit<CheckCommand, 'plain' | 'cwd'>;

/** A tool's check from its arguments, or null when this invocation is not one. */
type ToolRule = (args: string[]) => Found | null;

const always =
  (kind: CheckKind, tool: CheckTool, skip?: string[]): ToolRule =>
  (args) =>
    check(kind, tool, args, skip);

/** A rule that applies unless one of `flags` (or subcommands) is present. */
const unless =
  (words: string[], rule: ToolRule): ToolRule =>
  (args) =>
    args.some((arg) => words.includes(arg)) ? null : rule(args);

/** A rule keyed by the first argument (`cargo test`, `go vet`, `biome lint`). */
const bySubcommand =
  (tool: CheckTool, kinds: Record<string, CheckKind>): ToolRule =>
  ([sub, ...rest]) => {
    const kind = sub ? kinds[sub] : undefined;
    return kind ? check(kind, tool, sub === 'nextest' ? rest.slice(1) : rest) : null;
  };

/** `ruff check`, `ruff format`, or the old `ruff <path>`; `ruff --version` is not a check. */
const ruff: ToolRule = (args) => {
  const [sub] = args;
  if (sub === 'format') return check('format', 'ruff', args.slice(1));
  if (sub === 'check') return check('lint', 'ruff', args.slice(1));
  return sub && !sub.startsWith('-') && /[./]/.test(sub) ? check('lint', 'ruff', args) : null;
};

/** prettier only formats (or checks) with `--write` / `--check`. */
const prettier: ToolRule = (args) =>
  args.some((arg) => ['--check', '-c', '--write', '-w'].includes(arg))
    ? check('format', 'prettier', args)
    : null;

const TOOL_RULES: Record<string, ToolRule> = {
  vitest: (args) =>
    ['watch', 'dev', 'bench'].includes(args[0] ?? '')
      ? null
      : check('test', 'vitest', args, ['run', 'related']),
  jest: always('test', 'jest'),
  playwright: ([sub, ...rest]) => (sub === 'test' ? check('test', 'playwright', rest) : null),
  pytest: always('test', 'pytest'),
  'py.test': always('test', 'pytest'),
  tsc: unless(['--watch', '-w'], always('typecheck', 'tsc')),
  'vue-tsc': unless(['--watch', '-w'], always('typecheck', 'tsc')),
  mypy: always('typecheck', 'mypy'),
  pyright: always('typecheck', 'pyright'),
  oxlint: always('lint', 'oxlint'),
  eslint: always('lint', 'eslint'),
  ruff,
  biome: bySubcommand('biome', { lint: 'lint', check: 'lint', ci: 'lint', format: 'format' }),
  oxfmt: always('format', 'oxfmt'),
  prettier,
  cargo: bySubcommand('cargo', {
    test: 'test',
    nextest: 'test',
    clippy: 'lint',
    check: 'typecheck',
    fmt: 'format',
    build: 'build',
  }),
  go: bySubcommand('go', { test: 'test', vet: 'lint', build: 'build' }),
};

/** A tool invocation as a check, or null. */
function toolCheck(name: string, args: string[]): Found | null {
  return Object.hasOwn(TOOL_RULES, name) ? TOOL_RULES[name](args) : null;
}

/** Package-manager flags that take a value and come before the script. */
const PM_FLAGS = /^(--cwd|--filter|-F|-C|--dir|--prefix|-w|--workspace)$/;

const skipPmFlags = (args: string[]) => {
  let rest = args;
  while (rest[0] && PM_FLAGS.test(rest[0])) rest = rest.slice(2);
  return rest;
};

/**
 * The script a package-manager command runs, with its arguments: `<pm> run x`,
 * `npm test`, or pnpm / yarn's `<pm> x`. Null for anything else (`bun x` runs
 * a file, `npm x` is not a script).
 */
function scriptArgs(pm: string, args: string[]): string[] | null {
  if (args[0] === 'run' || args[0] === 'run-script') return skipPmFlags(args.slice(1));
  if (pm === 'npm' && (args[0] === 'test' || args[0] === 't')) return ['test', ...args.slice(1)];
  return pm === 'bun' || pm === 'npm' ? null : args;
}

/** funny's own task runner: `bun run steps lint`. */
function stepsCheck(task: string | undefined): Found | null {
  const kind = task ? scriptKind(task) : null;
  return kind ? { kind, tool: 'script', script: `steps ${task}`, scope: [] } : null;
}

/** A package.json script run as a check, or null. */
function scriptCheck(argv: string[]): Found | null {
  const [pm, ...rest] = argv;
  if (!PACKAGE_MANAGERS.has(pm)) return null;
  const args = skipPmFlags(rest);
  if (pm === 'bun' && args[0] === 'test') return check('test', 'bun-test', args.slice(1));
  const script = scriptArgs(pm, args);
  if (!script?.[0]) return null;
  // `pnpm vitest` / `yarn tsc` run the binary, not a script of that name.
  if (script === args && toolCheck(script[0], script.slice(1))) return null;
  return namedScriptCheck(script[0], script.slice(1));
}

/** `<name> <args>` as a script check: funny's `steps <task>`, or a check-named script. */
function namedScriptCheck(name: string, rest: string[]): Found | null {
  if (name === 'steps') return stepsCheck(rest[0]);
  const kind = scriptKind(name);
  if (!kind) return null;
  return {
    ...check(
      kind,
      'script',
      rest.filter((arg) => arg !== '--'),
    ),
    script: name,
  };
}

/** A single shell command (no chaining) as a check, or null. */
function segmentCheck(text: string): Found | null {
  const argv = words(text);
  const script = scriptCheck(argv);
  if (script) return script;
  const tool = toolOf(argv);
  return tool ? toolCheck(tool.name, tool.args) : null;
}

/**
 * The check a shell command runs, or null when it runs none. For a compound
 * command (`a && b`, `x | tail`), the first check in it, with `plain: false`.
 */
export function classifyCheckCommand(command: string): CheckCommand | null {
  const { cwd, rest } = stripPrefix(command);
  const at = cwd ? { cwd } : {};
  const withoutStderr = rest.replace(/\s+2>&1(?=\s|$)/g, '');
  if (!COMPOUND.test(withoutStderr)) {
    const found = segmentCheck(withoutStderr);
    return found ? { ...found, plain: true, ...at } : null;
  }
  for (const part of command.split(/\n|&&|\|\||;|\|/)) {
    const inner = stripPrefix(part)
      .rest.replace(/\s+2>&1(?=\s|$)/g, '')
      .replace(/\s*[<>].*$/, '');
    const found = inner ? segmentCheck(inner) : null;
    if (found) return { ...found, plain: false, ...at };
  }
  return null;
}
