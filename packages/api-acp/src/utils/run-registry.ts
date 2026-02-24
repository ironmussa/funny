/**
 * RunRegistry — tracks in-flight runs for status queries and cancellation.
 *
 * Each run has an AbortController (to abort the SDK query), an optional
 * Query reference (to call .close()), and lifecycle status.
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk';

// ── Types ────────────────────────────────────────────────────

export type RunStatus = 'created' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface RunUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ToolCallInfo {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface RunResult {
  text: string;
  tool_calls?: ToolCallInfo[];
}

export interface Run {
  id: string;
  status: RunStatus;
  model: string;
  created_at: number;
  completed_at?: number;
  usage?: RunUsage;
  result?: RunResult;
  error?: { message: string };
}

interface RunEntry {
  run: Run;
  abortController: AbortController;
  query: Query | null;
}

// ── Registry ─────────────────────────────────────────────────

const entries = new Map<string, RunEntry>();

let counter = 0;

/** Generate a unique run ID. */
export function makeRunId(): string {
  return `run_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

/** Register a new run. */
export function register(id: string, model: string, abortController: AbortController): Run {
  const run: Run = {
    id,
    status: 'created',
    model,
    created_at: Math.floor(Date.now() / 1000),
  };
  entries.set(id, { run, abortController, query: null });
  return run;
}

/** Attach the SDK Query object once created. */
export function setQuery(id: string, query: Query): void {
  const entry = entries.get(id);
  if (entry) entry.query = query;
}

/** Transition run to running. */
export function setRunning(id: string): void {
  const entry = entries.get(id);
  if (entry) entry.run.status = 'running';
}

/** Transition run to completed with result. */
export function setCompleted(id: string, result: RunResult, usage?: RunUsage): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.run.status = 'completed';
  entry.run.completed_at = Math.floor(Date.now() / 1000);
  entry.run.result = result;
  entry.run.usage = usage;
}

/** Transition run to failed. */
export function setFailed(id: string, message: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entry.run.status = 'failed';
  entry.run.completed_at = Math.floor(Date.now() / 1000);
  entry.run.error = { message };
}

/** Cancel an active run. Returns true if found and cancelled. */
export function cancel(id: string): boolean {
  const entry = entries.get(id);
  if (!entry) return false;
  if (entry.run.status === 'completed' || entry.run.status === 'cancelled' || entry.run.status === 'failed') {
    return false; // already terminal
  }
  entry.abortController.abort();
  entry.query?.close();
  entry.run.status = 'cancelled';
  entry.run.completed_at = Math.floor(Date.now() / 1000);
  return true;
}

/** Get a run's current state. */
export function get(id: string): Run | undefined {
  return entries.get(id)?.run;
}

/** Remove a run from the registry (cleanup after terminal state). */
export function remove(id: string): void {
  entries.delete(id);
}

/** Cancel all active runs (graceful shutdown). */
export function cancelAll(): void {
  for (const [, entry] of entries) {
    if (entry.run.status === 'running' || entry.run.status === 'created') {
      entry.abortController.abort();
      entry.query?.close();
      entry.run.status = 'cancelled';
    }
  }
  entries.clear();
}

/** Number of currently tracked runs. */
export function size(): number {
  return entries.size;
}
