/**
 * YAML loader integration tests.
 *
 * Validates that built-in pipelines load + compile, that user overrides
 * win, that Archon-compat dir is read when enabled, and that malformed
 * user YAMLs surface as warnings (not exceptions).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { loadPipelines } from '../../pipelines/yaml-loader.js';
import { resolveBuiltinAgentByName } from '../../services/agent-registry.js';

// ── Helpers ──────────────────────────────────────────────────

const resolveAgent = resolveBuiltinAgentByName;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'funny-yaml-loader-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────

describe('loadPipelines', () => {
  test('loads the built-in defaults from disk', async () => {
    const result = await loadPipelines({
      repoRoot: workDir,
      resolveAgent,
    });

    const names = [...result.pipelines.keys()].sort();
    expect(names).toEqual([
      'code-quality',
      'code-review',
      'commit',
      'orchestrator-thread',
      'pre-push',
    ]);

    for (const p of result.pipelines.values()) {
      expect(p.source).toBe('built-in');
      expect(p.definition.name).toBe(p.name);
    }
  });

  test('user override wins over built-in with the same name', async () => {
    const userDir = path.join(workDir, '.funny', 'pipelines');
    await mkdir(userDir, { recursive: true });
    await writeFile(
      path.join(userDir, 'commit.yaml'),
      `
name: commit
description: User-overridden commit
inputs:
  commit_message: { type: string, required: true }
nodes:
  - id: noop
    notify:
      message: "user version: {{commit_message}}"
      `,
      'utf8',
    );

    const result = await loadPipelines({
      repoRoot: workDir,
      resolveAgent,
    });

    const commit = result.pipelines.get('commit');
    expect(commit?.source).toBe('user');
    expect(commit?.parsed.description).toBe('User-overridden commit');
  });

  test('archonInterop=false ignores .archon/workflows/', async () => {
    const archonDir = path.join(workDir, '.archon', 'workflows');
    await mkdir(archonDir, { recursive: true });
    await writeFile(
      path.join(archonDir, 'commit.yaml'),
      `
name: commit
description: Archon override
nodes:
  - id: noop
    notify:
      message: "archon version"
      `,
      'utf8',
    );

    const result = await loadPipelines({ repoRoot: workDir, resolveAgent });
    expect(result.pipelines.get('commit')?.source).toBe('built-in');
  });

  test('archonInterop=true reads .archon/workflows/, user still wins', async () => {
    const archonDir = path.join(workDir, '.archon', 'workflows');
    await mkdir(archonDir, { recursive: true });
    await writeFile(
      path.join(archonDir, 'extra.yaml'),
      `
name: extra
description: From archon
nodes:
  - id: noop
    notify: { message: "from archon" }
      `,
      'utf8',
    );

    const result = await loadPipelines({
      repoRoot: workDir,
      resolveAgent,
      archonInterop: true,
    });

    expect(result.pipelines.get('extra')?.source).toBe('archon');

    // User wins when both layers define the same name.
    const userDir = path.join(workDir, '.funny', 'pipelines');
    await mkdir(userDir, { recursive: true });
    await writeFile(
      path.join(userDir, 'extra.yaml'),
      `
name: extra
description: From user
nodes:
  - id: noop
    notify: { message: "from user" }
      `,
      'utf8',
    );

    const result2 = await loadPipelines({
      repoRoot: workDir,
      resolveAgent,
      archonInterop: true,
    });
    expect(result2.pipelines.get('extra')?.source).toBe('user');
  });

  test('malformed user YAML produces a warning, not an exception', async () => {
    const userDir = path.join(workDir, '.funny', 'pipelines');
    await mkdir(userDir, { recursive: true });
    await writeFile(path.join(userDir, 'broken.yaml'), 'not: [valid yaml\nbroken', 'utf8');

    const result = await loadPipelines({ repoRoot: workDir, resolveAgent });
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.includes('broken.yaml'))).toBe(true);
    // Built-ins still load.
    expect(result.pipelines.get('commit')).toBeDefined();
  });

  test('sub-pipeline references resolve from compiled subPipelines registry', async () => {
    // code-quality references commit, code-review, pre-push.
    const result = await loadPipelines({ repoRoot: workDir, resolveAgent });
    const cq = result.pipelines.get('code-quality');
    expect(cq).toBeDefined();
    // The pipeline definition is opaque; verify by introspecting the parsed
    // YAML that the references are present, and that the loader didn't warn
    // about a missing sub-pipeline.
    const refs = cq!.parsed.nodes.flatMap((n) => (n.pipeline ? [n.pipeline.name] : []));
    expect(refs).toEqual(['commit', 'code-review', 'pre-push']);
    expect(result.warnings.filter((w) => w.toLowerCase().includes('not found'))).toHaveLength(0);
  });
});
