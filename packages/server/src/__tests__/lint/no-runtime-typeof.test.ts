import { describe, expect, test } from 'bun:test';
import { join } from 'path';

// Issue #459: packages/server/src narrows unparsed values with value guards
// (src/lib/value-guards.ts), never with an inline `typeof` outside a
// `value is T` guard. Lint the package and require zero findings.
const ROOT = join(import.meta.dir, '../../../../..');
const GUARDS = join(import.meta.dir, '../../lib/value-guards.ts');
// Linting spawns oxlint with the JS plugins; under the parallel suite that can
// take longer than the default per-test timeout.
const LINT_TIMEOUT_MS = 120_000;
const SAMPLES = [
  '',
  'text',
  0,
  Number.NaN,
  true,
  10n,
  Symbol('s'),
  null,
  undefined,
  {},
  [],
  () => 1,
];

describe('no-runtime-typeof in packages/server', () => {
  test(
    'lint reports no inline typeof checks',
    () => {
      const run = Bun.spawnSync(
        ['bun', 'scripts/bun-lint.ts', 'packages/server/src', '--format', 'unix'],
        { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
      );
      const output = run.stdout.toString() + run.stderr.toString();
      const findings = output.split('\n').filter((line) => line.includes('no-runtime-typeof'));
      expect(run.exitCode).toBe(0);
      expect(findings).toEqual([]);
    },
    LINT_TIMEOUT_MS,
  );

  test('value guards accept exactly what the typeof they replace accepted', async () => {
    const guards = await import(GUARDS).catch(() => undefined);
    expect(guards).toBeDefined();
    if (!guards) return;
    const pairs = [
      [guards.isString, 'string'],
      [guards.isNumber, 'number'],
      [guards.isBoolean, 'boolean'],
      [guards.isBigInt, 'bigint'],
      [guards.isSymbol, 'symbol'],
    ] as const;
    for (const [guard, type] of pairs) {
      for (const sample of SAMPLES) expect(guard(sample)).toBe(typeof sample === type);
    }
    for (const sample of SAMPLES) {
      const isObject = typeof sample === 'object' && sample !== null;
      expect(guards.isObject(sample)).toBe(isObject);
      expect(guards.isPlainObject(sample)).toBe(isObject && !Array.isArray(sample));
    }
    expect(SAMPLES.filter(guards.isNonEmptyString)).toEqual(['text']);
  });
});
