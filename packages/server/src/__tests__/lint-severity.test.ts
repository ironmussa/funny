import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Issue #465: once the #447 cleanups cleared a rule, it became an error so its
// findings cannot come back. A rule moves back to 'warn' only with a reason.
const ROOT = join(import.meta.dir, '..', '..', '..', '..');

type RuleSetting = string | [string, ...unknown[]];
interface LintConfig {
  rules: Record<string, RuleSetting>;
  overrides: Array<{ files: string[]; rules: Record<string, RuleSetting> }>;
}

// Loaded at run time: the repository's config lives outside this package's rootDir.
const config = ((await import(join(ROOT, 'oxlint.config.ts'))) as { default: LintConfig }).default;

const PROMOTED = [
  'anti-slop/no-known-value-widening',
  'anti-slop/no-runtime-typeof',
  'anti-slop/no-unknown-parameters',
  'anti-slop/no-unknown-returns',
  'anti-slop/require-safety-comment-for-type-assertion',
  'react/refs',
  'react/set-state-in-effect',
  'max-lines',
  'max-lines-per-function',
];

/** Rules that still have findings (#465's pull request lists them with their counts). */
const STILL_WARN = ['anti-slop/no-unsafe-dictionary-type'];

const rules: Record<string, RuleSetting> = config.rules;

const level = (setting: RuleSetting | undefined) => (Array.isArray(setting) ? setting[0] : setting);

/** The rules the client override applies to packages/client/src. */
function clientRules(): Record<string, RuleSetting> {
  const override = config.overrides.find((o) =>
    o.files.includes('packages/client/src/**/*.{ts,tsx}'),
  );
  if (!override) throw new Error('client override not found');
  return override.rules;
}

describe('lint severity (#465)', () => {
  test.each(PROMOTED)('%s is an error', (rule) => {
    expect(level(rules[rule])).toBe('error');
  });

  test.each(STILL_WARN)('%s stays a warning', (rule) => {
    expect(level(rules[rule])).toBe('warn');
  });

  test('no-runtime-typeof keeps allowInTypeGuards', () => {
    expect(rules['anti-slop/no-runtime-typeof']).toEqual(['error', { allowInTypeGuards: true }]);
  });

  test('max-lines-per-function keeps its options', () => {
    expect(rules['max-lines-per-function']).toEqual([
      'error',
      { max: 250, skipBlankLines: true, skipComments: true, IIFEs: true },
    ]);
  });

  test('shadcn/no-inline-styles is an error and no-restyle a warning in the client', () => {
    const client = clientRules();
    expect(level(client['shadcn/no-inline-styles'])).toBe('error');
    expect(level(client['shadcn/no-restyle'])).toBe('warn');
  });

  test('createFactoryTriage fits max-lines-per-function', () => {
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(ROOT, 'scripts', 'bun-lint.ts'),
        '--format',
        'agent',
        join('packages', 'server', 'src', 'services', 'factory', 'factory-triage.ts'),
      ],
      { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    const out = `${run.stdout.toString()}${run.stderr.toString()}`;
    expect(out).not.toContain('max-lines-per-function');
    expect(run.exitCode).toBe(0);
  }, 60_000);
});
