/**
 * The agent threads a run started, with the step each one ran (openspec
 * factory-run-detail, D3): triage's, the implementing one (continued across
 * steps), and one reviewer per review. Each thread once, in the order it started.
 * A triage or a reviewer still working is listed from `roleThreads`: its
 * answer, which names its thread too, comes only when it ends.
 */
import type { FactoryRun } from '@funny/shared/contracts/factory';

export type FactoryRunThreadRole = 'triage' | 'implementer' | 'reviewer' | 'agent';

export interface FactoryRunThreadLink {
  threadId: string;
  role: FactoryRunThreadRole;
  /** The flow steps the thread ran, in order. */
  steps: string[];
}

export function factoryRunThreadLinks(
  run: Pick<FactoryRun, 'triage' | 'stepOptions' | 'reviews' | 'roleThreads'>,
): FactoryRunThreadLink[] {
  const links = new Map<string, FactoryRunThreadLink>();
  const add = (threadId: string | undefined, role: FactoryRunThreadRole, step?: string) => {
    if (!threadId) return;
    const link = links.get(threadId) ?? { threadId, role, steps: [] };
    if (step && !link.steps.includes(step)) link.steps.push(step);
    links.set(threadId, link);
  };
  add(run.triage?.threadId, 'triage', 'triage');
  for (const role of run.roleThreads) {
    if (role.role === 'triage') add(role.threadId, 'triage', 'triage');
  }
  const reviewers = new Set(run.reviews.map((review) => review.threadId));
  const roleOf = (step: FactoryRun['stepOptions'][number]): FactoryRunThreadRole => {
    if (reviewers.has(step.threadId)) return 'reviewer';
    return step.thread === 'continue' ? 'implementer' : 'agent';
  };
  for (const step of run.stepOptions) add(step.threadId, roleOf(step), step.stepId);
  for (const review of run.reviews) add(review.threadId, 'reviewer', 'review');
  for (const role of run.roleThreads) {
    if (role.role === 'review') add(role.threadId, 'reviewer', 'review');
  }
  return [...links.values()];
}
