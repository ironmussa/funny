import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
