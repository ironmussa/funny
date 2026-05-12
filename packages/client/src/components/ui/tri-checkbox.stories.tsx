import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect } from 'storybook/test';

import { TriCheckbox } from '@/components/ui/tri-checkbox';

const meta = {
  title: 'UI/TriCheckbox',
  component: TriCheckbox,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    state: {
      control: 'select',
      options: ['checked', 'unchecked', 'indeterminate'],
    },
    size: {
      control: 'select',
      options: ['default', 'sm'],
    },
  },
} satisfies Meta<typeof TriCheckbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {
  args: { state: 'unchecked' },
};

export const Checked: Story = {
  args: { state: 'checked' },
};

export const Indeterminate: Story = {
  args: { state: 'indeterminate' },
};

export const SmallUnchecked: Story = {
  args: { state: 'unchecked', size: 'sm' },
};

export const SmallChecked: Story = {
  args: { state: 'checked', size: 'sm' },
};

export const SmallIndeterminate: Story = {
  args: { state: 'indeterminate', size: 'sm' },
};

export const AllStates: Story = {
  args: { state: 'unchecked' },
  render: () => (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <TriCheckbox state="unchecked" data-testid="tri-unchecked" />
          <span className="text-xs text-muted-foreground">Unchecked</span>
        </div>
        <div className="flex items-center gap-2">
          <TriCheckbox state="checked" data-testid="tri-checked" />
          <span className="text-xs text-muted-foreground">Checked</span>
        </div>
        <div className="flex items-center gap-2">
          <TriCheckbox state="indeterminate" data-testid="tri-indeterminate" />
          <span className="text-xs text-muted-foreground">Indeterminate</span>
        </div>
      </div>
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <TriCheckbox state="unchecked" size="sm" data-testid="tri-sm-unchecked" />
          <span className="text-xs text-muted-foreground">sm Unchecked</span>
        </div>
        <div className="flex items-center gap-2">
          <TriCheckbox state="checked" size="sm" data-testid="tri-sm-checked" />
          <span className="text-xs text-muted-foreground">sm Checked</span>
        </div>
        <div className="flex items-center gap-2">
          <TriCheckbox state="indeterminate" size="sm" data-testid="tri-sm-indeterminate" />
          <span className="text-xs text-muted-foreground">sm Indeterminate</span>
        </div>
      </div>
    </div>
  ),
};

function InteractiveStory() {
  const cycle: Array<'unchecked' | 'checked' | 'indeterminate'> = [
    'unchecked',
    'checked',
    'indeterminate',
  ];
  const [idx, setIdx] = useState(0);
  const state = cycle[idx % cycle.length];
  return (
    <div className="flex items-center gap-3">
      <TriCheckbox
        state={state}
        onToggle={() => setIdx((i) => i + 1)}
        data-testid="tri-interactive"
        aria-label="Toggle state"
      />
      <span className="text-sm text-foreground">{state}</span>
    </div>
  );
}

/** Cycles through unchecked → checked → indeterminate → unchecked on each click */
export const Interactive: Story = {
  args: { state: 'unchecked' },
  render: () => <InteractiveStory />,
};

function FileListExampleStory() {
  const files = ['index.ts', 'stage.ts', 'stash.ts', 'status.ts'];
  const [selected, setSelected] = useState<Set<string>>(new Set(files));

  const toggleFile = (f: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === files.length) setSelected(new Set());
    else setSelected(new Set(files));
  };

  const headerState =
    selected.size === files.length ? 'checked' : selected.size > 0 ? 'indeterminate' : 'unchecked';

  return (
    <div className="w-64 rounded-md border border-sidebar-border bg-sidebar p-2">
      <div className="mb-2 flex items-center gap-2 border-b border-sidebar-border pb-2">
        <TriCheckbox
          state={headerState as 'checked' | 'unchecked' | 'indeterminate'}
          onToggle={toggleAll}
          data-testid="tri-select-all"
          aria-label="Select all files"
        />
        <span className="text-xs text-muted-foreground">
          {selected.size}/{files.length} selected
        </span>
      </div>
      {files.map((f) => (
        <div key={f} className="flex items-center gap-2 py-1">
          <TriCheckbox
            state={selected.has(f) ? 'checked' : 'unchecked'}
            onToggle={() => toggleFile(f)}
            data-testid={`tri-file-${f}`}
            aria-label={`Select ${f}`}
          />
          <span className="font-mono text-xs text-foreground">{f}</span>
        </div>
      ))}
    </div>
  );
}

/** Simulates a file list with select-all header and individual items */
export const FileListExample: Story = {
  args: { state: 'checked' },
  render: () => <FileListExampleStory />,
};

// --- Interaction Tests ---

function CycleStatesStory() {
  const cycle: Array<'unchecked' | 'checked' | 'indeterminate'> = [
    'unchecked',
    'checked',
    'indeterminate',
  ];
  const [idx, setIdx] = useState(0);
  return (
    <TriCheckbox
      state={cycle[idx % cycle.length]}
      onToggle={() => setIdx((i) => i + 1)}
      data-testid="tri-cycle"
    />
  );
}

export const CycleStates: Story = {
  args: { state: 'unchecked' },
  render: () => <CycleStatesStory />,
  play: async ({ canvas, userEvent }) => {
    const checkbox = canvas.getByTestId('tri-cycle');
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(checkbox);
    await expect(checkbox).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(checkbox);
    await expect(checkbox).toHaveAttribute('aria-checked', 'mixed');
    await userEvent.click(checkbox);
    await expect(checkbox).toHaveAttribute('aria-checked', 'false');
  },
};
