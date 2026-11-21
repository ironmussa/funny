/**
 * Parse warnings: a valid workflow can carry warnings that block nothing.
 * The one warning today points at dependents of an `on_error: continue`
 * node that rely on the default join and so are skipped when it fails.
 */

import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { builtInWorkflowsDir } from '../catalog.js';
import { parseWorkflowYaml } from '../parse.js';

function flow(notifyExtra = '', extraNodes = ''): string {
  return `
name: review
nodes:
  - id: tests
    run_command: { command: bun test }
    on_error: continue
${extraNodes}
  - id: notify
    depends_on: [tests]
${notifyExtra}
    notify: { message: done }
`.trim();
}

function warningsOf(yaml: string) {
  const result = parseWorkflowYaml(yaml);
  if (!result.ok) throw new Error(`expected a valid flow: ${result.error.message}`);
  return result.warnings;
}

describe('continue-join warning', () => {
  test('warns a dependent on the default join, and the flow stays valid', () => {
    const warnings = warningsOf(flow());
    expect(warnings).toEqual([
      {
        path: 'nodes.1.trigger_rule',
        message:
          '"notify" is skipped if "tests" fails (on_error: continue). ' +
          'Add `trigger_rule: all_done` if it must run anyway.',
      },
    ]);
  });

  test.each(['all_success', 'all_done'])('an explicit trigger_rule: %s silences it', (rule) => {
    expect(warningsOf(flow(`    trigger_rule: ${rule}`))).toEqual([]);
  });

  test('a continue node without dependents is not warned', () => {
    const yaml = `
name: solo
nodes:
  - id: tests
    run_command: { command: bun test }
    on_error: continue
  - id: notify
    notify: { message: done }
`.trim();
    expect(warningsOf(yaml)).toEqual([]);
  });

  test('a dependent on two continue nodes gets one warning naming both', () => {
    const yaml = `
name: two
nodes:
  - id: lint
    run_command: { command: bun run lint }
    on_error: continue
  - id: tests
    run_command: { command: bun test }
    on_error: continue
  - id: notify
    depends_on: [lint, tests]
    notify: { message: done }
`.trim();
    const warnings = warningsOf(yaml);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].path).toBe('nodes.2.trigger_rule');
    expect(warnings[0].message).toContain('"lint", "tests" fail (on_error: continue)');
  });

  test('a dependent of a fail node is not warned', () => {
    const yaml = `
name: strict
nodes:
  - id: tests
    run_command: { command: bun test }
  - id: notify
    depends_on: [tests]
    notify: { message: done }
`.trim();
    expect(warningsOf(yaml)).toEqual([]);
  });
});

describe('bundled workflows', () => {
  test('parse with no warnings', async () => {
    const dir = builtInWorkflowsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const result = parseWorkflowYaml(await readFile(path.join(dir, file), 'utf8'), file);
      if (!result.ok) throw new Error(`${file}: ${result.error.message}`);
      expect({ file, warnings: result.warnings }).toEqual({ file, warnings: [] });
    }
  });
});
