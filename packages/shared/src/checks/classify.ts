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

/** The tool and its arguments, after any package runner. */
function toolOf(argv: string[]): { name: string; args: string[] } | null {
  let rest = argv;
  const first = rest[0]?.replace(/^(?:\.\/)?node_modules\/\.bin\//, '');
  if (!first) return null;
  rest = [first, ...rest.slice(1)];
  const two = `${rest[0]} ${rest[1] ?? ''}`;
  const skip = RUNNERS[two] ?? RUNNERS[rest[0]];
  if (skip) rest = rest.slice(skip);
  // pnpm and yarn run a package's binaries directly: `pnpm vitest run`.
  else if (rest[0] === 'pnpm' || rest[0] === 'yarn') rest = rest.slice(rest[1] === 'dlx' ? 2 : 1);
  // npx flags (`npx -y vitest`) come before the tool.
  while (rest[0]?.startsWith('-')) rest = rest.slice(1);
  return rest[0] ? { name: rest[0], args: rest.slice(1) } : null;
}

/** A tool invocation as a check, or null. */
function toolCheck(name: string, args: string[]): Omit<CheckCommand, 'plain' | 'cwd'> | null {
  const sub = args[0];
  switch (name) {
    case 'vitest':
      return sub === 'watch' || sub === 'dev' || sub === 'bench'
        ? null
        : check('test', 'vitest', args, ['run', 'related']);
    case 'jest':
      return check('test', 'jest', args);
    case 'playwright':
      return sub === 'test' ? check('test', 'playwright', args.slice(1)) : null;
    case 'pytest':
    case 'py.test':
      return check('test', 'pytest', args);
    case 'tsc':
    case 'vue-tsc':
      return args.includes('--watch') || args.includes('-w')
        ? null
        : check('typecheck', 'tsc', args);
    case 'mypy':
      return check('typecheck', 'mypy', args);
    case 'pyright':
      return check('typecheck', 'pyright', args);
    case 'oxlint':
      return check('lint', 'oxlint', args);
    case 'eslint':
      return check('lint', 'eslint', args);
    case 'ruff':
      if (sub === 'format') return check('format', 'ruff', args.slice(1));
      // `ruff check`, or the old `ruff <path>` form; `ruff --version` is not a check.
      return sub === 'check' || (sub && !sub.startsWith('-') && /[./]/.test(sub))
        ? check('lint', 'ruff', sub === 'check' ? args.slice(1) : args)
        : null;
    case 'biome':
      if (sub === 'format') return check('format', 'biome', args.slice(1));
      return sub === 'lint' || sub === 'check' || sub === 'ci'
        ? check('lint', 'biome', args.slice(1))
        : null;
    case 'oxfmt':
      return check('format', 'oxfmt', args);
    case 'prettier':
      return args.includes('--check') ||
        args.includes('-c') ||
        args.includes('--write') ||
        args.includes('-w')
        ? check('format', 'prettier', args)
        : null;
    case 'cargo': {
      const cargoKind: Record<string, CheckKind> = {
        test: 'test',
        nextest: 'test',
        clippy: 'lint',
        check: 'typecheck',
        fmt: 'format',
        build: 'build',
      };
      const kind = sub ? cargoKind[sub] : undefined;
      return kind ? check(kind, 'cargo', args.slice(sub === 'nextest' ? 2 : 1)) : null;
    }
    case 'go': {
      const goKind: Record<string, CheckKind> = { test: 'test', vet: 'lint', build: 'build' };
      const kind = sub ? goKind[sub] : undefined;
      return kind ? check(kind, 'go', args.slice(1)) : null;
    }
    default:
      return null;
  }
}

/** A package.json script run as a check, or null. */
function scriptCheck(argv: string[]): Omit<CheckCommand, 'plain' | 'cwd'> | null {
  const [pm, ...rest] = argv;
  if (!PACKAGE_MANAGERS.has(pm)) return null;
  let args = rest;
  // `--cwd x`, `--filter x`, `-C x`, `--prefix x` before the script.
  while (args[0] && /^(--cwd|--filter|-F|-C|--dir|--prefix|-w|--workspace)$/.test(args[0]))
    args = args.slice(2);
  if (pm === 'bun' && args[0] === 'test') return check('test', 'bun-test', args.slice(1));
  if (args[0] === 'run' || args[0] === 'run-script') args = args.slice(1);
  else if (pm === 'npm' && (args[0] === 'test' || args[0] === 't'))
    args = ['test', ...args.slice(1)];
  else if (pm === 'bun' || pm === 'npm') return null;
  while (args[0] && /^(--cwd|--filter|-F|-C|--dir|--prefix)$/.test(args[0])) args = args.slice(2);
  const name = args[0];
  if (!name) return null;
  // `pnpm vitest` / `yarn tsc` run the binary, not a script of that name.
  if (pm !== 'npm' && pm !== 'bun' && rest[0] === name && toolCheck(name, args.slice(1)))
    return null;
  // funny's own task runner: `bun run steps lint`.
  if (name === 'steps') {
    const task = args[1] ? scriptKind(args[1]) : null;
    return task ? { kind: task, tool: 'script', script: `steps ${args[1]}`, scope: [] } : null;
  }
  const kind = scriptKind(name);
  if (!kind) return null;
  const extra = args.slice(1).filter((arg) => arg !== '--');
  return { ...check(kind, 'script', extra), script: name };
}

/** A single shell command (no chaining) as a check, or null. */
function segmentCheck(text: string): Omit<CheckCommand, 'plain' | 'cwd'> | null {
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
