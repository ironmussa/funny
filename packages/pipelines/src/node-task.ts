/**
 * One node task as the scheduler sees it: run the node (`node-runner.ts`),
 * then evaluate its loop condition when it closes a loop region.
 */

import { Effect, Exit } from 'effect';

import type { NodeRunInfo, PipelineStateChange } from './engine.js';
import type { SlotGrant } from './gate.js';
import type { GraphNode, Region } from './graph.js';
import { causeMessage, invoke, runSingleNode } from './node-runner.js';
import type { NodeData } from './types.js';

/** What one node task reports back to the scheduler. */
export type TaskResult<T> =
  | { kind: 'succeeded'; ctx: T; loop?: 'exit' | 'again' }
  | { kind: 'skipped'; ctx: T }
  | { kind: 'failed'; ctx: T; error: string }
  | { kind: 'cancelled'; ctx?: T };

export interface TaskParams<T> {
  signal: AbortSignal;
  emit: (c: PipelineStateChange<T>) => void;
  iteration: number;
  stopGraceMs?: number;
  acquireSlot?: (signal: AbortSignal, onWait: () => void) => Promise<SlotGrant>;
  adoptBatchOutput?: (input: T, output: NodeData) => T;
  /** The loop this node declares, if any. */
  loopRegion?: Region<T>;
  info?: Omit<NodeRunInfo, 'iteration'>;
}

/** Run one node, then evaluate its loop condition when it closes a loop region. */
export async function runNodeTask<T>(
  node: GraphNode<T>,
  input: T,
  params: TaskParams<T>,
): Promise<TaskResult<T>> {
  const res = await runSingleNode(node.def, input, params);
  switch (res.status) {
    case 'cancelled':
      // A synchronous node can commit its result and abort the run in the same
      // call; keep that result (the node runner only adopts it in that case).
      return res.committed ? { kind: 'cancelled', ctx: res.ctx } : { kind: 'cancelled' };
    case 'error':
      return { kind: 'failed', ctx: res.ctx, error: res.error ?? 'failed' };
    case 'skipped':
      return { kind: 'skipped', ctx: res.ctx };
    case 'completed':
      return untilAfter(res.ctx, params);
  }
}

/** A node succeeded with `ctx`: evaluate its loop condition, if it declares a loop. */
export async function untilAfter<T>(
  ctx: T,
  params: { signal: AbortSignal; loopRegion?: Region<T> },
): Promise<TaskResult<T>> {
  const { signal, loopRegion } = params;
  if (!loopRegion) return { kind: 'succeeded', ctx };
  const condition = await Effect.runPromiseExit(
    invoke(() => loopRegion.until(ctx)),
    { signal },
  );
  if (signal.aborted) return { kind: 'cancelled', ctx };
  if (Exit.isFailure(condition)) {
    return { kind: 'failed', ctx, error: causeMessage(condition.cause) };
  }
  return { kind: 'succeeded', ctx, loop: condition.value ? 'exit' : 'again' };
}
