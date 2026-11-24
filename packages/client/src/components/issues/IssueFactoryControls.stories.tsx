import { EMPTY_FACTORY_RUN_METRICS } from '@funny/shared/contracts/factory';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { expect, within } from 'storybook/test';

import { IssueFactoryStatus, IssuesFactoryBar } from '@/components/issues/IssueFactoryControls';
import type { FactoryRun, FactorySettings } from '@/lib/api/factory';

/**
 * The issue factory in the Issues tab (change factory-manual-queue): each
 * issue's state in the caller's factory, and the bar that sends the selected
 * issues with a flow. The flows and blockers queries are not served here, so
 * the bar falls back to the factory's own flow and shows no blocker warning.
 */

const run = (over: Partial<FactoryRun>): FactoryRun => ({
  id: 'run',
  factoryId: 'factory',
  issueNumber: 12,
  prUrl: null,
  state: 'working',
  currentStep: 'implement',
  threadIds: ['thread-1'],
  startedAt: '2026-11-16T00:00:00.000Z',
  completedAt: null,
  source: 'manual',
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
  ...over,
});

const settings = (over: Partial<FactorySettings> = {}): FactorySettings => ({
  projectId: 'project-1',
  enabled: true,
  mode: 'manual',
  label: 'ready-for-agent',
  flowName: 'issue-to-merge',
  maxConcurrent: 2,
  autoMerge: 'low_risk',
  sensitivePaths: [],
  stageLimits: {},
  stepOverrides: {},
  batch: { size: 5, waitSeconds: 60 },
  dependencies: 'wait',
  blockedReason: null,
  updatedAt: '2026-11-16T00:00:00.000Z',
  ...over,
});

const STATES: Array<{ run: FactoryRun; position?: number }> = [
  {
    run: run({ id: 'q1', issueNumber: 3, state: 'requested', threadIds: [], queueOrder: 1 }),
    position: 1,
  },
  {
    run: run({
      id: 'q2',
      issueNumber: 4,
      state: 'requested',
      threadIds: [],
      queueOrder: 2,
      waitReason: { kind: 'blocker-not-sent', blockers: [2] },
    }),
    position: 2,
  },
  { run: run({ id: 'w', issueNumber: 5, state: 'working' }) },
  { run: run({ id: 'ci', issueNumber: 6, state: 'waiting_ci' }) },
  { run: run({ id: 'h', issueNumber: 7, state: 'waiting_human' }) },
  { run: run({ id: 'm', issueNumber: 8, state: 'merged' }) },
  { run: run({ id: 'f', issueNumber: 9, state: 'failed' }) },
];

function StatusGallery() {
  return (
    <MemoryRouter>
      <ul className="flex flex-col gap-2 text-xs">
        {STATES.map(({ run, position }) => (
          <li key={run.id} className="flex items-center gap-2">
            <span className="text-muted-foreground w-8">#{run.issueNumber}</span>
            <IssueFactoryStatus projectId="project-1" run={run} position={position} />
          </li>
        ))}
      </ul>
    </MemoryRouter>
  );
}

const meta: Meta<typeof IssuesFactoryBar> = {
  title: 'Issues/IssueFactoryControls',
  component: IssuesFactoryBar,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: {
    projectId: 'project-1',
    settings: settings(),
    selected: [12, 15],
    onSent: () => {},
    onClear: () => {},
  },
  decorators: [
    (Story) => (
      <div className="bg-sidebar w-[420px] rounded-md border">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

/** Two issues selected on a running factory: ready to send. */
export const SendBar: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('issues-factory-send')).toBeEnabled();
    await expect(canvas.getByTestId('issues-factory-flow')).toHaveTextContent('issue-to-merge');
  },
};

/** A paused factory takes no sends, and says how to resume it. */
export const Paused: Story = {
  args: { settings: settings({ enabled: false }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('issues-factory-send')).toBeDisabled();
    await expect(canvas.getByTestId('issues-factory-disabled-reason')).toBeVisible();
  },
};

/** A factory that cannot work now (here, its runner is offline) shows why. */
export const CannotWork: Story = {
  args: {
    settings: settings({
      blockedReason:
        "Waiting for your runner: the project's repository could not be read (is your runner online, and does the project have a GitHub origin?).",
    }),
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('issues-factory-send')).toBeDisabled();
  },
};

/** Every state an issue can show in the list, with the queue position and a wait reason. */
export const IssueStates: Story = {
  render: () => <StatusGallery />,
  decorators: [(Story) => <div className="p-3">{Story()}</div>],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('issue-factory-status-3')).toBeVisible();
    await expect(canvas.getByTestId('issue-factory-cancel-3')).toBeVisible();
    await expect(canvas.getByTestId('issue-factory-send-blockers-4')).toBeVisible();
  },
};
