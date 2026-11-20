import type { EnrichedGitHubIssue } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

import { IssuesDialog } from './IssuesDialog';

/* ------------------------------------------------------------------ */
/*  Mock data                                                         */
/* ------------------------------------------------------------------ */

const MOCK_ISSUES: EnrichedGitHubIssue[] = [
  {
    number: 42,
    title: 'Login form should validate email format before submission',
    state: 'open',
    body: 'Currently the login form accepts any string as email. We should add client-side validation.',
    created_at: '2026-04-08T10:00:00Z',
    updated_at: '2026-04-09T08:00:00Z',
    html_url: 'https://github.com/acme/app/issues/42',
    user: { login: 'octocat', avatar_url: '' },
    labels: [
      { name: 'bug', color: 'd73a4a' },
      { name: 'good first issue', color: '7057ff' },
    ],
    comments: 3,
    linkedBranch: null,
    linkedPR: null,
    suggestedBranchName: 'fix/42-login-email-validation',
  },
  {
    number: 38,
    title: 'Add dark mode support',
    state: 'open',
    body: 'Users have requested a dark mode theme.',
    created_at: '2026-04-05T14:00:00Z',
    updated_at: '2026-04-07T09:00:00Z',
    html_url: 'https://github.com/acme/app/issues/38',
    user: { login: 'contributor42', avatar_url: '' },
    labels: [{ name: 'enhancement', color: '84b6eb' }],
    comments: 7,
    linkedBranch: 'feat/dark-mode',
    linkedPR: { number: 45, url: 'https://github.com/acme/app/pull/45', state: 'open' },
    suggestedBranchName: 'feat/38-dark-mode',
  },
  {
    number: 35,
    title: 'Improve error messages for API timeout responses',
    state: 'open',
    body: null,
    created_at: '2026-04-01T08:00:00Z',
    updated_at: '2026-04-01T08:00:00Z',
    html_url: 'https://github.com/acme/app/issues/35',
    user: { login: 'devuser', avatar_url: '' },
    labels: [],
    comments: 0,
    linkedBranch: null,
    linkedPR: null,
    suggestedBranchName: 'fix/35-api-timeout-errors',
  },
  {
    number: 30,
    title: 'Migrate database schema to use UUIDs instead of auto-increment IDs',
    state: 'open',
    body: 'For multi-region deployment we need UUID primary keys.',
    created_at: '2026-03-28T12:00:00Z',
    updated_at: '2026-03-29T10:00:00Z',
    html_url: 'https://github.com/acme/app/issues/30',
    user: { login: 'octocat', avatar_url: '' },
    labels: [
      { name: 'breaking-change', color: 'e11d48' },
      { name: 'database', color: '0e8a16' },
    ],
    comments: 12,
    linkedBranch: 'feat/uuid-migration',
    linkedPR: null,
    suggestedBranchName: 'feat/30-uuid-migration',
  },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function mockApi(issues: EnrichedGitHubIssue[] = MOCK_ISSUES, hasMore = false) {
  api.githubIssuesEnriched = () =>
    okAsync({
      issues,
      hasMore,
      owner: 'acme',
      repo: 'app',
    });
}

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function IssuesTrigger({
  label,
  setupMocks,
  onCreateThread,
}: {
  label: string;
  setupMocks: () => void;
  onCreateThread?: typeof IssuesDialog extends React.FC<infer P>
    ? P extends { onCreateThread?: infer C }
      ? C
      : never
    : never;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        data-testid="issues-trigger"
        onClick={() => {
          setupMocks();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <IssuesDialog
        projectId="proj-1"
        open={open}
        onOpenChange={setOpen}
        onCreateThread={onCreateThread ?? (() => setOpen(false))}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Dialogs/IssuesDialog',
  component: IssuesDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default — list of open issues with labels, linked branches, and PRs. */
export const Default: Story = {
  render: () => <IssuesTrigger label="View issues" setupMocks={() => mockApi()} />,
};

/** Issues with "Load more" pagination. */
export const WithPagination: Story = {
  render: () => (
    <IssuesTrigger label="View issues (paginated)" setupMocks={() => mockApi(MOCK_ISSUES, true)} />
  ),
};

/** Empty state — no issues found. */
export const Empty: Story = {
  render: () => <IssuesTrigger label="View issues (empty)" setupMocks={() => mockApi([])} />,
};

/** Loading state — API never resolves. */
export const Loading: Story = {
  render: () => (
    <IssuesTrigger
      label="View issues (loading)"
      setupMocks={() => {
        api.githubIssuesEnriched = () => new ResultAsync(new Promise(() => {}));
      }}
    />
  ),
};

/** Error state. */
export const Error: Story = {
  render: () => (
    <IssuesTrigger
      label="View issues (error)"
      setupMocks={() => {
        api.githubIssuesEnriched = () =>
          errAsync({
            type: 'INTERNAL',
            message: 'GitHub API rate limit exceeded. Try again in 30 seconds.',
          });
      }}
    />
  ),
};

/** Without create-thread callback — no "+" buttons shown. */
export const ReadOnly: Story = {
  render: () => (
    <IssuesTrigger
      label="View issues (read-only)"
      setupMocks={() => mockApi()}
      onCreateThread={undefined}
    />
  ),
};

/** Many issues (stress test for scroll). */
export const ManyIssues: Story = {
  render: () => {
    const many: EnrichedGitHubIssue[] = Array.from({ length: 30 }, (_, i) => ({
      number: 100 + i,
      title: `Issue #${100 + i}: ${['Fix', 'Add', 'Update', 'Remove', 'Refactor'][i % 5]} ${['auth', 'UI', 'API', 'database', 'tests'][i % 5]} ${['module', 'component', 'endpoint', 'schema', 'suite'][i % 5]}`,
      state: 'open' as const,
      body: null,
      created_at: new Date(Date.now() - i * 86400000).toISOString(),
      updated_at: new Date(Date.now() - i * 86400000).toISOString(),
      html_url: `https://github.com/acme/app/issues/${100 + i}`,
      user: { login: ['octocat', 'contributor42', 'devuser'][i % 3], avatar_url: '' },
      labels: i % 3 === 0 ? [{ name: 'bug', color: 'd73a4a' }] : [],
      comments: i % 4,
      linkedBranch: null,
      linkedPR: null,
      suggestedBranchName: `fix/${100 + i}-issue`,
    }));
    return <IssuesTrigger label="View issues (30 items)" setupMocks={() => mockApi(many)} />;
  },
};
