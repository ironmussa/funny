import type { Meta, StoryObj } from '@storybook/react-vite';
import { okAsync, ResultAsync } from 'neverthrow';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

import { PublishRepoDialog } from './PublishRepoDialog';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function mockApi(orgs: string[] = ['acme-corp', 'my-org']) {
  api.projectGetGhOrgs = () => okAsync({ orgs });
  api.projectPublish = () =>
    okAsync({ ok: true, repoUrl: 'https://github.com/octocat/my-project' });
}

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function PublishRepoTrigger({ label, setupMocks }: { label: string; setupMocks: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        data-testid="publish-repo-trigger"
        onClick={() => {
          setupMocks();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <PublishRepoDialog
        projectId="proj-1"
        projectPath="/home/user/projects/my-awesome-app"
        open={open}
        onOpenChange={setOpen}
        onSuccess={() => setOpen(false)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Dialogs/PublishRepoDialog',
  component: PublishRepoDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default form with org options loaded. */
export const Default: Story = {
  render: () => <PublishRepoTrigger label="Publish repository" setupMocks={() => mockApi()} />,
};

/** No organizations — only personal account available. */
export const NoOrgs: Story = {
  render: () => <PublishRepoTrigger label="Publish (no orgs)" setupMocks={() => mockApi([])} />,
};

/** Orgs loading — API never resolves. */
export const OrgsLoading: Story = {
  render: () => (
    <PublishRepoTrigger
      label="Publish (orgs loading)"
      setupMocks={() => {
        api.projectGetGhOrgs = () => new ResultAsync(new Promise(() => {}));
      }}
    />
  ),
};
