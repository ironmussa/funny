import type { Meta, StoryObj } from '@storybook/react-vite';
import { Suspense, useState } from 'react';

import { Button } from '@/components/ui/button';

import { ExpandedDiffDialog } from './ExpandedDiffDialog';
import { ReactDiffViewer, DIFF_VIEWER_STYLES } from './utils';

/* -------------------------------------------------------------------------- */
/*  Sample diff content                                                       */
/* -------------------------------------------------------------------------- */

const OLD_SIMPLE = `function greet(name) {
  return "Hello, " + name;
}`;

const NEW_SIMPLE = `function greet(name: string) {
  return \`Hello, \${name}!\`;
}`;

const OLD_MULTILINE = `import { useState } from 'react';

interface Props {
  title: string;
}

export function Card({ title }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card">
      <h2>{title}</h2>
      <button onClick={() => setOpen(!open)}>Toggle</button>
      {open && <p>Content goes here</p>}
    </div>
  );
}`;

const NEW_MULTILINE = `import { useState, useCallback } from 'react';

import { cn } from '@/lib/utils';

interface Props {
  title: string;
  className?: string;
  defaultOpen?: boolean;
}

export function Card({ title, className, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  const handleToggle = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  return (
    <div className={cn("card", className)}>
      <h2>{title}</h2>
      <button onClick={handleToggle} data-testid="card-toggle">
        {open ? 'Collapse' : 'Expand'}
      </button>
      {open && (
        <div className="card-content">
          <p>Content goes here</p>
        </div>
      )}
    </div>
  );
}`;

const OLD_ADDITIONS_ONLY = `export const routes = [
  { path: '/', component: Home },
  { path: '/about', component: About },
];`;

const NEW_ADDITIONS_ONLY = `export const routes = [
  { path: '/', component: Home },
  { path: '/about', component: About },
  { path: '/settings', component: Settings },
  { path: '/profile', component: Profile },
  { path: '/dashboard', component: Dashboard },
];`;

const OLD_DELETIONS_ONLY = `export const config = {
  debug: true,
  verbose: true,
  logLevel: 'trace',
  enableTelemetry: true,
  experimentalFeatures: true,
  port: 3000,
};`;

const NEW_DELETIONS_ONLY = `export const config = {
  debug: false,
  port: 3000,
};`;

/* -------------------------------------------------------------------------- */
/*  Wrapper component (handles Suspense for lazy-loaded ReactDiffViewer)       */
/* -------------------------------------------------------------------------- */

function DiffViewerWrapper({
  oldValue,
  newValue,
  splitView = false,
  showDiffOnly = true,
  hideLineNumbers = false,
}: {
  oldValue: string;
  newValue: string;
  splitView?: boolean;
  showDiffOnly?: boolean;
  hideLineNumbers?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="text-xs [&_.diff-container]:font-mono [&_.diff-container]:text-sm">
        <Suspense
          fallback={<div className="p-4 text-sm text-muted-foreground">Loading diff...</div>}
        >
          <ReactDiffViewer
            oldValue={oldValue}
            newValue={newValue}
            splitView={splitView}
            useDarkTheme={true}
            hideLineNumbers={hideLineNumbers}
            showDiffOnly={showDiffOnly}
            styles={DIFF_VIEWER_STYLES}
          />
        </Suspense>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Storybook meta                                                            */
/* -------------------------------------------------------------------------- */

const meta = {
  title: 'Components/InlineDiff',
  component: DiffViewerWrapper,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof DiffViewerWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

/* -------------------------------------------------------------------------- */
/*  Stories                                                                    */
/* -------------------------------------------------------------------------- */

export const UnifiedSimple: Story = {
  name: 'Unified — Simple Edit',
  args: {
    oldValue: OLD_SIMPLE,
    newValue: NEW_SIMPLE,
    splitView: false,
  },
};

export const SplitSimple: Story = {
  name: 'Split — Simple Edit',
  args: {
    oldValue: OLD_SIMPLE,
    newValue: NEW_SIMPLE,
    splitView: true,
  },
};

export const UnifiedMultiline: Story = {
  name: 'Unified — Multi-line Refactor',
  args: {
    oldValue: OLD_MULTILINE,
    newValue: NEW_MULTILINE,
    splitView: false,
  },
};

export const SplitMultiline: Story = {
  name: 'Split — Multi-line Refactor',
  args: {
    oldValue: OLD_MULTILINE,
    newValue: NEW_MULTILINE,
    splitView: true,
  },
};

export const AdditionsOnly: Story = {
  name: 'Additions Only',
  args: {
    oldValue: OLD_ADDITIONS_ONLY,
    newValue: NEW_ADDITIONS_ONLY,
    splitView: false,
  },
};

export const DeletionsOnly: Story = {
  name: 'Deletions Only',
  args: {
    oldValue: OLD_DELETIONS_ONLY,
    newValue: NEW_DELETIONS_ONLY,
    splitView: false,
  },
};

export const NoChanges: Story = {
  name: 'No Changes',
  args: {
    oldValue: OLD_SIMPLE,
    newValue: OLD_SIMPLE,
    splitView: false,
  },
};

export const ShowAllLines: Story = {
  name: 'Show All Lines (no collapse)',
  args: {
    oldValue: OLD_MULTILINE,
    newValue: NEW_MULTILINE,
    splitView: false,
    showDiffOnly: false,
  },
};

export const HiddenLineNumbers: Story = {
  name: 'Hidden Line Numbers',
  args: {
    oldValue: OLD_SIMPLE,
    newValue: NEW_SIMPLE,
    splitView: false,
    hideLineNumbers: true,
  },
};

export const ExpandedDiffDialogStory: Story = {
  name: 'Expanded Diff Dialog',
  args: {
    oldValue: OLD_MULTILINE,
    newValue: NEW_MULTILINE,
  },
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <Button data-testid="diff-open-dialog" onClick={() => setOpen(true)}>
          Open Expanded Diff Dialog
        </Button>
        <ExpandedDiffDialog
          open={open}
          onOpenChange={setOpen}
          filePath="packages/client/src/components/Card.tsx"
          oldValue={OLD_MULTILINE}
          newValue={NEW_MULTILINE}
        />
      </div>
    );
  },
};
