import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { loadWorkflowCatalog } from '../catalog.js';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'funny-workflows-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('loadWorkflowCatalog', () => {
  test('loads defaults beside a production bundle without repository sources', async () => {
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
    const dist = path.join(workDir, 'dist');
    execFileSync('bun', [
      'build',
      path.join(packageRoot, 'src/catalog.ts'),
      '--target=bun',
      '--outdir',
      dist,
    ]);
    await cp(path.join(packageRoot, 'defaults'), path.join(dist, 'defaults'), { recursive: true });
    const output = execFileSync(
      'bun',
      [
        '-e',
        'const { loadWorkflowCatalog } = await import(process.argv[1]); ' +
          'console.log(JSON.stringify([...(await loadWorkflowCatalog()).workflows.keys()].sort()))',
        path.join(dist, 'catalog.js'),
      ],
      { cwd: workDir, encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toEqual([
      'code-quality',
      'code-review',
      'commit',
      'fusion',
      'pre-push',
      'scheduler-thread',
    ]);
  });

  test('loads built-in workflow defaults', async () => {
    const result = await loadWorkflowCatalog({ repoRoot: workDir });
    expect([...result.workflows.keys()].sort()).toEqual([
      'code-quality',
      'code-review',
      'commit',
      'fusion',
      'pre-push',
      'scheduler-thread',
    ]);
    expect(result.workflows.get('commit')?.source).toBe('built-in');
  });

  test('project .funny/workflows override wins over built-in', async () => {
    const workflowsDir = path.join(workDir, '.funny', 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(
      path.join(workflowsDir, 'commit.yaml'),
      `
name: commit
description: Project override
nodes:
  - id: noop
    notify: { message: "override" }
`,
      'utf8',
    );

    const result = await loadWorkflowCatalog({ repoRoot: workDir });
    const commit = result.workflows.get('commit');
    expect(commit?.source).toBe('user');
    expect(commit?.workflow.description).toBe('Project override');
  });

  test('legacy .funny/pipelines files are ignored', async () => {
    const legacyDir = path.join(workDir, '.funny', 'pipelines');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, 'commit.yaml'),
      `
name: commit
description: Legacy override
nodes:
  - id: noop
    notify: { message: "legacy" }
`,
      'utf8',
    );

    const result = await loadWorkflowCatalog({ repoRoot: workDir });
    expect(result.workflows.get('commit')?.source).toBe('built-in');
    expect(result.workflows.get('commit')?.workflow.description).not.toBe('Legacy override');
  });

  test('malformed project workflow yields a warning without blocking built-ins', async () => {
    const workflowsDir = path.join(workDir, '.funny', 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(path.join(workflowsDir, 'broken.yaml'), 'not: [valid yaml\nbroken', 'utf8');

    const result = await loadWorkflowCatalog({ repoRoot: workDir });
    expect(result.warnings.some((warning) => warning.includes('broken.yaml'))).toBe(true);
    expect(result.workflows.get('scheduler-thread')).toBeDefined();
  });
});
