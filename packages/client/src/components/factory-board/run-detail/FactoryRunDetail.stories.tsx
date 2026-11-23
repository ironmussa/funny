import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { expect, within } from 'storybook/test';

import { FactoryRunDetail } from '@/components/factory-board/run-detail/FactoryRunDetail';
import { buildFactoryRun } from '@/data/factory/testing';
import type { FactoryQueueRun } from '@/lib/api/factory';

/**
 * A factory run's detail panel (openspec factory-run-detail): its story in
 * pipeline order, each agent step linked to its thread.
 */
const meta = {
  title: 'Factory/FactoryRunDetail',
  component: FactoryRunDetail,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <MemoryRouter>
        <Story />
      </MemoryRouter>
    ),
  ],
} satisfies Meta<typeof FactoryRunDetail>;

export default meta;
type Story = StoryObj<typeof meta>;

const at = '2026-11-23T10:00:00.000Z';
const step = (stepId: string, threadId: string, thread: 'continue' | 'new' = 'continue') => ({
  stepId,
  threadId,
  provider: 'claude',
  model: 'opus',
  effort: 'high' as const,
  permissionMode: 'autoEdit',
  allowedTools: null,
  disallowedTools: null,
  thread,
});

const EVERY_SECTION: FactoryQueueRun = {
  ...buildFactoryRun({
    id: 'run-42',
    issueNumber: 42,
    state: 'waiting_human',
    currentStep: 'merge',
    failureReason: 'high risk',
    prUrl: 'https://github.com/acme/app/pull/12',
    flowSteps: [
      'triage',
      'implement',
      'pull-request',
      'address',
      'regression-proof',
      'ci',
      'review',
      'merge',
    ],
    flowSource: 'repository',
    flowCommit: '9f8e7d6c5b4a',
    threadIds: ['t-impl'],
    triage: {
      decision: 'ready',
      at,
      threadId: 't-triage',
      contract: {
        acceptanceCriteria: [
          'Logging out clears the session cookie',
          'The login page shows after logout',
        ],
        likelyPaths: ['packages/server/src/auth/**'],
        riskHints: [],
      },
    },
    regressionProof: {
      headSha: 'bbb2222ffff',
      verdict: 'pass',
      files: ['packages/server/src/__tests__/logout.test.ts'],
      commands: ['bun test packages/server/src/__tests__/logout.test.ts'],
      ranAt: at,
    },
    reviews: [
      {
        sha: 'aaa1111ffff',
        verdict: 'fail',
        summary: 'The cookie is cleared but the session row stays.',
        findings: [
          {
            severity: 'high',
            title: 'Session row not deleted',
            path: 'packages/server/src/auth/logout.ts',
            line: 31,
          },
          {
            severity: 'low',
            title: 'Unused import',
            path: 'packages/server/src/auth/logout.ts',
            line: 2,
          },
        ],
        reviewedAt: at,
        threadId: 't-rev-1',
      },
      {
        sha: 'bbb2222ffff',
        verdict: 'pass',
        summary: 'Looks right.',
        findings: [],
        reviewedAt: at,
        threadId: 't-rev-2',
      },
    ],
    risk: { headSha: 'bbb2222ffff', level: 'high', reasons: ['touches packages/server/src/auth'] },
    stepOptions: [
      step('triage', 't-triage', 'new'),
      step('implement', 't-impl'),
      step('address', 't-impl'),
      step('review', 't-rev-1', 'new'),
      step('review', 't-rev-2', 'new'),
    ],
  }),
  projectId: 'p1',
};
EVERY_SECTION.metrics = {
  ...EVERY_SECTION.metrics,
  ciRounds: 2,
  ciRed: 1,
  agentFixes: 1,
  reviews: 2,
  reviewFails: 1,
  mergeHolds: 1,
};

export const EverySection: Story = {
  args: { run: EVERY_SECTION, projectName: 'acme/app', onClose: () => {} },
  play: async () => {
    const body = within(document.body);
    await expect(body.getByTestId('factory-run-detail-review-0')).toHaveTextContent(
      'Session row not deleted',
    );
    await expect(body.getByTestId('factory-run-detail-threads')).toBeInTheDocument();
  },
};

export const JustQueued: Story = {
  args: {
    run: {
      ...buildFactoryRun({
        id: 'run-7',
        issueNumber: 7,
        state: 'requested',
        completedAt: null,
        waitReason: { kind: 'paths-overlap', blockers: [42] },
      }),
      projectId: 'p1',
    },
    projectName: 'acme/app',
    onClose: () => {},
  },
};
