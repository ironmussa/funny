import { EMPTY_FACTORY_RUN_METRICS } from '@funny/shared/contracts/factory';
import type { FactoryRun, FactorySettings } from '@funny/shared/contracts/factory';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { factorySettingsQuery } from './queries';

/** A complete `FactoryRun` for tests and stories (a merged label run); overrides win. */
export function buildFactoryRun(overrides: Partial<FactoryRun> = {}): FactoryRun {
  return {
    id: 'run-1',
    factoryId: 'f1',
    issueNumber: 1,
    issueTitle: null,
    triggerName: null,
    inputs: {},
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
    metrics: { ...EMPTY_FACTORY_RUN_METRICS },
    regressionProof: null,
    reviews: [],
    risk: null,
    triage: null,
    flowSource: null,
    flowCommit: null,
    stepOptions: [],
    mergeApproval: null,
    riskWaiver: null,
    ...overrides,
  };
}

/** Seed a project's factory settings into its cached read (tests and stories). */
export function seedFactorySettings(
  projectId: string,
  settings: FactorySettings | null,
  layer: DataLayer = getDataLayer(),
): void {
  layer.queryClient.setQueryData(factorySettingsQuery(projectId).queryKey, settings);
}
