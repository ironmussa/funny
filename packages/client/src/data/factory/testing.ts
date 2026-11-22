import type { FactoryRun } from '@funny/shared/contracts/factory';

/** A complete `FactoryRun` for tests and stories (a merged label run); overrides win. */
export function buildFactoryRun(overrides: Partial<FactoryRun> = {}): FactoryRun {
  return {
    id: 'run-1',
    factoryId: 'f1',
    issueNumber: 1,
    prUrl: null,
    state: 'merged',
    currentStep: null,
    threadIds: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T01:00:00.000Z',
    source: 'label',
    flowName: 'issue-to-merge',
    queueOrder: null,
    waitReason: null,
    flowSteps: [],
    failureReason: null,
    admittedAt: null,
    metrics: { ciRounds: 0, ciRed: 0, conflicts: 0, ciBlocked: 0, ciTimeouts: 0, agentFixes: 0 },
    regressionProof: null,
    ...overrides,
  };
}
