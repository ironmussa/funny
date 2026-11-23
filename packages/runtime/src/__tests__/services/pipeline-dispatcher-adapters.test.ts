/**
 * Verifies the production adapters that plug `PipelineDispatcher` into the
 * rest of the runtime:
 *
 *   - `YamlPipelineLoader` finds a built-in workflow by name and returns a
 *     runnable PipelineDefinition.
 *   - The same loader returns null for an unknown name (so the dispatcher
 *     can surface { ok: false } cleanly).
 *   - `RuntimeActionProviderFactory` constructs a `RuntimeActionProvider`
 *     bound to the calling thread's identity.
 *
 * The factory test does NOT exercise actions end-to-end (that path
 * needs the full thread-service / DB / WS broker stack); it asserts the
 * resulting provider exposes the ActionProvider surface and is the right
 * concrete type. End-to-end action behavior is already covered by
 * `pipeline-adapter` tests under `services/`.
 */

import { describe, expect, test } from 'bun:test';

import { RuntimeActionProvider } from '../../services/pipeline-adapter.js';
import {
  RuntimeActionProviderFactory,
  YamlPipelineLoader,
} from '../../services/pipeline-dispatcher-adapters.js';

const scope = { projectId: 'p1', userId: 'u1', cwd: process.cwd() };

describe('YamlPipelineLoader', () => {
  test('loads a built-in workflow by name', async () => {
    const loaded = await new YamlPipelineLoader().load('commit', scope);
    expect(loaded).not.toBeNull();
    expect(loaded?.definition.name).toBe('commit');
    expect(loaded?.definition.nodes.length).toBeGreaterThan(0);
  });

  test('returns null for an unknown pipeline name', async () => {
    expect(await new YamlPipelineLoader().load('does-not-exist', scope)).toBeNull();
  });
});

describe('RuntimeActionProviderFactory', () => {
  test('builds a RuntimeActionProvider bound to the dispatch identity', () => {
    const factory = new RuntimeActionProviderFactory();
    const provider = factory.build({
      threadId: 't1',
      projectId: 'p1',
      userId: 'u1',
      cwd: '/repo',
      prompt: 'go',
      pipelineName: 'commit',
    });

    expect(provider).toBeInstanceOf(RuntimeActionProvider);
    // ActionProvider surface present
    expect(typeof provider.spawnAgent).toBe('function');
    expect(typeof provider.gitCommit).toBe('function');
    expect(typeof provider.gitPush).toBe('function');
    expect(typeof provider.notify).toBe('function');
  });
});
