import type { Design } from '@funny/shared';
import type { CreateDesignRequest } from '@funny/shared/contracts/designs';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { okAsync } from 'neverthrow';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/toast';
import { api } from '@/lib/api';

import { CreateDesignDialog } from './CreateDesignDialog';

/* ------------------------------------------------------------------ */
/*  API mocking                                                       */
/* ------------------------------------------------------------------ */

function designFor(input: CreateDesignRequest): Design {
  return {
    id: 'design-1',
    projectId: 'proj-1',
    userId: 'user-1',
    name: input.name,
    type: input.type,
    fidelity: null,
    speakerNotes: false,
    folderPath: '/tmp/design-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mockApi(opts: { fail?: boolean } = {}) {
  api.createDesign = (_projectId, input) => {
    if (opts.fail) {
      return okAsync(designFor(input)).map((): Design => {
        throw new Error('mock failure');
      });
    }
    return okAsync(designFor(input));
  };

  api.createDesignDirectory = () => okAsync({ ok: true, path: '/tmp/design-1' });
}

/* ------------------------------------------------------------------ */
/*  Trigger wrapper                                                   */
/* ------------------------------------------------------------------ */

function CreateDesignTrigger({ label, setupMocks }: { label: string; setupMocks: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <Toaster />
      <Button
        variant="outline"
        data-testid="create-design-trigger"
        onClick={() => {
          setupMocks();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <CreateDesignDialog
        open={open}
        onOpenChange={setOpen}
        projectId="proj-1"
        projectName="my-awesome-app"
      />
    </MemoryRouter>
  );
}

/* ------------------------------------------------------------------ */
/*  Storybook meta                                                    */
/* ------------------------------------------------------------------ */

const meta: Meta = {
  title: 'Dialogs/CreateDesignDialog',
  component: CreateDesignDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/* ------------------------------------------------------------------ */
/*  Stories                                                            */
/* ------------------------------------------------------------------ */

/** Default — Prototype tab with high-fidelity selected. */
export const Default: Story = {
  render: () => <CreateDesignTrigger label="Create design" setupMocks={() => mockApi()} />,
};
