import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { withProjects } from '@/data/projects/testing';
import { useProjectStore } from '@/stores/project-store';

import { CommandPalette } from './CommandPalette';

/* ------------------------------------------------------------------ */
/*  Mock data                                                         */
/* ------------------------------------------------------------------ */

const MOCK_PROJECTS = [
  {
    id: 'proj-1',
    name: 'my-api-server',
    path: '/home/user/projects/my-api-server',
    userId: 'u1',
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'proj-2',
    name: 'frontend-app',
    path: '/home/user/projects/frontend-app',
    userId: 'u1',
    createdAt: '2026-02-01T00:00:00Z',
  },
  {
    id: 'proj-3',
    name: 'shared-utils',
    path: '/home/user/projects/shared-utils',
    userId: 'u1',
    createdAt: '2026-03-01T00:00:00Z',
  },
];

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function CommandPaletteTrigger({
  label,
  projects,
}: {
  label: string;
  projects: typeof MOCK_PROJECTS;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        data-testid="command-palette-trigger"
        onClick={() => {
          useProjectStore.setState(withProjects({ projects: projects as any }));
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Components/CommandPalette',
  component: CommandPalette,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default — shows projects and settings sections. */
export const Default: Story = {
  render: () => <CommandPaletteTrigger label="Open command palette" projects={MOCK_PROJECTS} />,
};

/** No projects — shows empty state message. */
export const NoProjects: Story = {
  render: () => <CommandPaletteTrigger label="Open (no projects)" projects={[]} />,
};
