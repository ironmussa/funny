/**
 * Verifies the production adapters that plug `SchedulerPipelineDispatcher`
 * into the rest of the runtime:
 *
 *   - `YamlPipelineLoader` finds the built-in `scheduler-thread.yaml`
 *     default and returns a runnable PipelineDefinition.
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

import { describe, expect, test } from 'vitest';

import { RuntimeActionProvider } from '../../services/pipeline-adapter.js';
import {
  RuntimeActionProviderFactory,
  YamlPipelineLoader,
  loadSchedulerPipeline,
} from '../../services/scheduler-pipeline-adapters.js';

describe('YamlPipelineLoader', () => {
  test('loads the built-in scheduler-thread default by name', async () => {
    const loader = new YamlPipelineLoader();
    const loaded = await loader.load('scheduler-thread', {
      projectId: 'p1',
      userId: 'u1',
      cwd: process.cwd(),
    });
    expect(loaded).not.toBeNull();
    expect(loaded?.definition.name).toBe('scheduler-thread');
    expect(loaded?.definition.nodes.length).toBeGreaterThan(0);
    expect(loaded?.inputs).toEqual(
      expect.objectContaining({
        prompt: expect.objectContaining({ type: 'string' }),
        threadId: expect.objectContaining({ type: 'string' }),
      }),
    );
  });

  test('scheduler-thread default sequences notify → status/stage flips → dispatch → review/done', async () => {
    const loader = new YamlPipelineLoader();
    const loaded = await loader.load('scheduler-thread', {
      projectId: 'p1',
      userId: 'u1',
      cwd: process.cwd(),
    });
    expect(loaded).not.toBeNull();
    const ids = loaded!.definition.nodes.map((n) => n.name);
    // Order matters — topo-sort should keep announce_start first and
    // announce_done last so the WS feed reads "dispatching → completed".
    expect(ids).toEqual([
      'announce-start',
      'mark-running',
      'mark-in-progress',
      'dispatch',
      'mark-review',
      'mark-completed',
      'announce-done',
    ]);
  });

  test('returns null for an unknown pipeline name', async () => {
    const loader = new YamlPipelineLoader();
    const def = await loader.load('does-not-exist', {
      projectId: 'p1',
      userId: 'u1',
      cwd: process.cwd(),
    });
    expect(def).toBeNull();
  });

  test('loadSchedulerPipeline (Result variant) wraps the loader', async () => {
    const okResult = await loadSchedulerPipeline('scheduler-thread', {
      projectId: 'p1',
      userId: 'u1',
      cwd: process.cwd(),
    });
    expect(okResult.isOk()).toBe(true);

    const errResult = await loadSchedulerPipeline('does-not-exist', {
      projectId: 'p1',
      userId: 'u1',
      cwd: process.cwd(),
    });
    expect(errResult.isErr()).toBe(true);
    if (errResult.isErr()) {
      expect(errResult.error).toMatch(/does-not-exist/);
    }
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
    });

    expect(provider).toBeInstanceOf(RuntimeActionProvider);
    // ActionProvider surface present
    expect(typeof provider.spawnAgent).toBe('function');
    expect(typeof provider.gitCommit).toBe('function');
    expect(typeof provider.gitPush).toBe('function');
    expect(typeof provider.notify).toBe('function');
  });
});
