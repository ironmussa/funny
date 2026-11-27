import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import {
  FactoryHealthStats,
  FactoryIncidentBanners,
} from '@/components/factory-board/FactoryHealthHeader';
import { buildFactoryRun, seedFactorySettings } from '@/data/factory/testing';
import type { FactoryQueueRun, FactoryRun } from '@/lib/api/factory';

/**
 * The factory view's health (openspec factory-run-detail): figures over the
 * listed runs, and a banner for a factory paused by an incident.
 */
const meta = {
  title: 'Factory/FactoryHealthHeader',
  component: FactoryHealthStats,
} satisfies Meta<typeof FactoryHealthStats>;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const ago = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const run = (
  id: string,
  state: FactoryRun['state'],
  over: Partial<FactoryRun> = {},
): FactoryQueueRun => ({
  ...buildFactoryRun({
    id,
    state,
    startedAt: ago(20),
    admittedAt: ago(18),
    completedAt: null,
    ...over,
  }),
  projectId: 'p1',
});
const passed = { sha: 'a', verdict: 'pass' as const, findings: [], reviewedAt: ago(3) };
const failed = {
  ...passed,
  verdict: 'fail' as const,
  findings: [{ severity: 'high' as const, title: 'bug' }],
};

const RUNS = [
  run('r1', 'working'),
  run('r2', 'reviewing', { reviews: [failed] }),
  run('r3', 'waiting_human', { reviews: [passed] }),
  run('r4', 'merged', { completedAt: ago(2), reviews: [passed] }),
  run('r5', 'merged', { completedAt: ago(30), reviews: [passed] }),
];

export const Figures: Story = {
  args: { runs: RUNS, now: NOW },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByTestId('factory-view-health-first-pass'),
    ).toHaveTextContent('75%');
  },
};

export const WithIncident: Story = {
  args: { runs: RUNS, now: NOW },
  render: (args) => {
    seedFactorySettings('p1', {
      projectId: 'p1',
      enabled: true,
      mode: 'automatic',
      label: 'factory',
      flowName: 'issue-to-merge',
      maxConcurrent: 4,
      autoMerge: 'low_risk',
      sensitivePaths: [],
      sizeGateEnabled: false,
      maxLowRiskLines: 400,
      approvalAdjustMaxLines: 0,
      sizeIgnoredPaths: [],
      stageLimits: {},
      stepOverrides: {},
      batch: { size: 5, waitSeconds: 60 },
      dependencies: 'wait',
      tooBig: 'ask',
      specStage: false,
      commitSpecPath: '',
      holdPathsAwaitingApproval: false,
      baseBranch: '',
      laneLabelPrefix: 'feature:',
      laneBranchPrefix: 'feature/',
      laneFinishBranch: '',
      blockedReason: null,
      updatedAt: ago(1),
      incident: {
        id: 'i1',
        repo: 'acme/app',
        baseBranch: 'main',
        state: 'reported',
        redSha: 'abc1234',
        openedAt: ago(1),
        closedAt: null,
        candidates: [],
        result: {
          decision: 'revert',
          reason: 'The logout change broke the session tests.',
          culpritPrUrl: 'https://github.com/acme/app/pull/34',
          revertPrUrl: 'https://github.com/acme/app/pull/50',
        },
      },
    });
    return (
      <div className="flex flex-col gap-2">
        <FactoryHealthStats {...args} />
        <FactoryIncidentBanners runs={args.runs} />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByTestId('factory-view-incident-p1'),
    ).toBeInTheDocument();
  },
};
