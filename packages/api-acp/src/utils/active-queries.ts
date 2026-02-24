/**
 * ActiveQueries — registry of in-flight SDK queries for cancellation support.
 *
 * Each chat completion request registers its AbortController and Query reference.
 * The cancel endpoint (or client disconnect) calls cancel(id) to abort the query.
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk';

interface ActiveEntry {
  abortController: AbortController;
  query: Query | null;
}

const entries = new Map<string, ActiveEntry>();

/** Register a new active query. Call this after creating the AbortController. */
export function register(id: string, abortController: AbortController, query: Query | null = null): void {
  entries.set(id, { abortController, query });
}

/** Attach the Query object once it's created (query() returns it synchronously). */
export function setQuery(id: string, query: Query): void {
  const entry = entries.get(id);
  if (entry) entry.query = query;
}

/** Cancel an active query by ID. Returns true if found and cancelled. */
export function cancel(id: string): boolean {
  const entry = entries.get(id);
  if (!entry) return false;

  entry.abortController.abort();
  entry.query?.close();
  entries.delete(id);
  return true;
}

/** Remove a completed query from the registry (normal cleanup). */
export function remove(id: string): void {
  entries.delete(id);
}

/** Cancel all active queries (graceful shutdown). */
export function cancelAll(): void {
  for (const [id, entry] of entries) {
    entry.abortController.abort();
    entry.query?.close();
  }
  entries.clear();
}

/** Number of currently active queries. */
export function size(): number {
  return entries.size;
}
