import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { FactoryBoard } from '@/components/factory-board/FactoryBoard';
import { FactoryRunCard } from '@/components/factory-board/FactoryRunCard';
import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryQueueRun, FactoryRun } from '@/lib/api/factory';

/**
 * The factory view's board (openspec factory-pipeline-board): a column per
 * pipeline stage, each run placed by its state, with its flow strip, gate
 * chips and why it waits. Read-only: only the server moves a run.
 */
const meta = {
  title: 'Factory/FactoryBoard',
  component: FactoryBoard,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof FactoryBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const ago = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const FLOW = [
  'triage',
  'implement',
  'pull-request',
  'address',
  'regression-proof',
  'ci',
  'review',
  'merge',
];
const PR = (n: number) => `https://github.com/acme/app/pull/${n}`;

let next = 40;
const run = (state: FactoryRun['state'], over: Partial<FactoryRun> = {}): FactoryQueueRun => {
  next += 1;
  return {
    ...buildFactoryRun({
      id: `run-${next}`,
      issueNumber: next,
      state,
      flowSteps: state === 'requested' ? [] : FLOW,
      startedAt: ago(6),
      admittedAt: state === 'requested' ? null : ago(3),
      completedAt: null,
      threadIds: ['thread-1'],
      ...over,
    }),
    projectId: 'p1',
  };
};

const verdict = (sha: string, pass: boolean) => ({
  sha,
  verdict: pass ? ('pass' as const) : ('fail' as const),
  findings: pass ? [] : [{ severity: 'high' as const, title: 'Missing null check' }],
  reviewedAt: ago(1),
});

/** One flow node execution, `start` and `end` in hours before NOW (`end` null: running). */
const tm = (step: string, start: number, end: number | null) => ({
  step,
  visit: '1',
  attempt: 1,
  status: end === null ? ('running' as const) : ('succeeded' as const),
  startedAt: ago(start),
  finishedAt: end === null ? null : ago(end),
});

const RUNS: FactoryQueueRun[] = [
  run('requested', { queueOrder: 1, waitReason: { kind: 'paths-overlap', blockers: [47] } }),
  run('requested', { queueOrder: 2, waitReason: { kind: 'blocker-in-progress', blockers: [44] } }),
  run('triaging', { currentStep: 'triage' }),
  run('working', { currentStep: 'implement' }),
  run('fixing', { currentStep: 'address', prUrl: PR(12) }),
  run('waiting_ci', {
    currentStep: 'ci',
    prUrl: PR(13),
    risk: { headSha: 'abc1234', level: 'low', reasons: [] },
    regressionProof: { headSha: 'abc1234', verdict: 'pass', ranAt: ago(1) },
  }),
  run('reviewing', {
    currentStep: 'review',
    prUrl: PR(14),
    reviews: [verdict('aaa1111', false)],
    risk: { headSha: 'bbb2222', level: 'low', reasons: [] },
    stepTimings: [
      tm('implement', 5, 4),
      tm('ci', 4, 3.5),
      tm('review', 3.4, 3),
      tm('address', 3, 2.2),
      tm('review', 2, null),
    ],
  }),
  run('merging', {
    currentStep: 'merge',
    prUrl: PR(15),
    reviews: [verdict('ccc3333', true)],
    risk: { headSha: 'ccc3333', level: 'low', reasons: [] },
    regressionProof: { headSha: 'ccc3333', verdict: 'pass', ranAt: ago(1) },
    stepTimings: [tm('implement', 4, 3), tm('ci', 3, 2.5), tm('review', 2.5, 0.4)],
  }),
  run('waiting_human', {
    currentStep: 'merge',
    prUrl: PR(16),
    failureReason: 'high risk',
    reviews: [verdict('ddd4444', true)],
    risk: { headSha: 'ddd4444', level: 'high', reasons: ['touches packages/server/src/auth'] },
  }),
  run('needs_info', {
    currentStep: 'triage',
    triage: { decision: 'needs_info', at: ago(2), items: ['Which page?', 'Which browser?'] },
  }),
  run('failed', { currentStep: 'ci', failureReason: 'CI kept failing after 3 fixes' }),
  run('no_change', { currentStep: 'implement' }),
  run('merged', {
    completedAt: ago(2),
    prUrl: PR(17),
    stepTimings: [
      tm('implement', 9, 8),
      tm('ci', 8, 7.6),
      tm('review', 7.6, 7.1),
      tm('merge', 7, 2),
    ],
  }),
  run('stopped', { completedAt: ago(5) }),
  run('merged', { completedAt: ago(80) }),
];

export const EveryState: Story = {
  args: {
    runs: RUNS,
    projectNameById: new Map([['p1', 'acme/app']]),
    now: NOW,
    singleProjectId: null,
    onSelect: () => {},
    onShowOlderDone: () => {},
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('factory-board-column-review')).toBeInTheDocument();
    await expect(canvas.getByTestId('factory-board-done-hidden')).toHaveTextContent('+1');
  },
};

export const Empty: Story = { args: { ...EveryState.args, runs: [] } };

export const Card: StoryObj<typeof FactoryRunCard> = {
  render: () => (
    <div className="w-92 p-3">
      <FactoryRunCard run={RUNS[6]!} projectName="acme/app" now={NOW} onSelect={() => {}} />
    </div>
  ),
};
