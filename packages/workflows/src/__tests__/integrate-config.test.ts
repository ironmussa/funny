/**
 * `.funny/integrate.yaml` (openspec factory-integration 3.3): regenerators and
 * checks, every problem named by its field.
 */
import { describe, expect, test } from 'bun:test';

import { parseIntegrateConfig } from '../integrate-config.js';

describe('parseIntegrateConfig', () => {
  test('a valid file gives its regenerators and checks', () => {
    const parsed = parseIntegrateConfig(`regenerate:
  - paths: [bun.lock, '**/bun.lock']
    run: bun install
  - paths: [migrations/*.sql]
    run: bun run db:renumber
    timeout_ms: 120000
checks:
  - bun run typecheck
`);
    expect(parsed).toEqual({
      ok: true,
      config: {
        regenerators: [
          { paths: ['bun.lock', '**/bun.lock'], run: 'bun install', timeoutMs: 600_000 },
          { paths: ['migrations/*.sql'], run: 'bun run db:renumber', timeoutMs: 120_000 },
        ],
        checks: ['bun run typecheck'],
      },
    });
  });

  test('an empty file regenerates nothing', () => {
    expect(parseIntegrateConfig('')).toEqual({
      ok: true,
      config: { regenerators: [], checks: [] },
    });
  });

  test('an invalid glob is refused, naming it', () => {
    const parsed = parseIntegrateConfig(`regenerate:
  - paths: [ok.lock, '/abs.lock', 'pkgs/{a,b}/x.lock', '../up.lock']
    run: bun install
`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.map((problem) => problem.field)).toEqual([
      'regenerate[0].paths[1]',
      'regenerate[0].paths[2]',
      'regenerate[0].paths[3]',
    ]);
  });

  test('a regenerator without a command is refused', () => {
    const parsed = parseIntegrateConfig(`regenerate:
  - paths: [bun.lock]
    run: '  '
  - paths: [x.lock]
`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.map((problem) => problem.field)).toEqual([
      'regenerate[0].run',
      'regenerate[1].run',
    ]);
  });

  test('unknown keys and broken YAML are refused', () => {
    expect(parseIntegrateConfig('regenerate: []\nmerge: weave\n')).toMatchObject({
      ok: false,
      problems: [{ field: 'file' }],
    });
    expect(parseIntegrateConfig('regenerate: [\n')).toMatchObject({
      ok: false,
      problems: [{ field: 'yaml' }],
    });
  });
});
