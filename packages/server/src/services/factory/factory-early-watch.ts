/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * When to integrate a run early (openspec factory-integration D8): the base
 * moved since the factory last looked, the run's changed paths (its pull
 * request's, or its contract's likely paths before there is one) overlap what
 * merged, and the host says its pull request no longer merges. A read only:
 * no push, no CI. The integration itself is the run's (`earlyIntegrate`).
 */

import type { EarlyOutcome } from './factory-early-integration.js';

/** A run in flight with a pull request, and the paths its change touches. */
export interface EarlyCandidate {
  runId: string;
  prNumber: number;
  paths: string[];
}

export interface EarlyWatchDeps {
  /** The base head each repository was at when it was last looked at, by key. */
  lastBase: Map<string, string>;
  key: string;
  head(): Promise<string | null>;
  changedPaths(from: string, to: string): Promise<string[] | null>;
  candidates(): Promise<EarlyCandidate[]>;
  /** Whether the pull request still merges; null while the host is computing it. */
  mergeable(prNumber: number): Promise<boolean | null>;
  integrate(runId: string): Promise<EarlyOutcome | 'not-running'>;
}

/** Whether two path lists share a path. */
const overlaps = (a: string[], b: Set<string>) => a.some((path) => b.has(path));

/** Look once: the runs asked to integrate early, with what each answered. */
export async function integrateEarly(
  deps: EarlyWatchDeps,
): Promise<Array<{ runId: string; outcome: EarlyOutcome | 'not-running' }>> {
  const head = await deps.head();
  if (!head) return [];
  const before = deps.lastBase.get(deps.key);
  deps.lastBase.set(deps.key, head);
  // The first look only learns where the base is.
  if (!before || before === head) return [];
  const changed = await deps.changedPaths(before, head);
  if (!changed || changed.length === 0) return [];
  const merged = new Set(changed);
  const asked: Array<{ runId: string; outcome: EarlyOutcome | 'not-running' }> = [];
  for (const run of await deps.candidates()) {
    if (!overlaps(run.paths, merged)) continue;
    if ((await deps.mergeable(run.prNumber)) !== false) continue;
    asked.push({ runId: run.runId, outcome: await deps.integrate(run.runId) });
  }
  return asked;
}
