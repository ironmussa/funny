import type { Meta, StoryObj } from '@storybook/react-vite';

import { VirtualDiff } from '@/components/VirtualDiff';

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
/*  Helper: compute a simple unified diff from old/new strings                */
/* -------------------------------------------------------------------------- */

function computeUnifiedDiff(oldValue: string, newValue: string): string {
  const oldLines = oldValue.split('\n');
  const newLines = newValue.split('\n');
  const lines: string[] = ['--- a/file', '+++ b/file'];

  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  )
    prefixLen++;

  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  )
    suffixLen++;

  const oldChanged = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newChanged = newLines.slice(prefixLen, newLines.length - suffixLen);
  const ctxBefore = Math.min(prefixLen, 3);
  const ctxAfter = Math.min(suffixLen, 3);
  const hunkOldStart = prefixLen - ctxBefore + 1;
  const hunkOldLen = ctxBefore + oldChanged.length + ctxAfter;
  const hunkNewLen = ctxBefore + newChanged.length + ctxAfter;

  lines.push(`@@ -${hunkOldStart},${hunkOldLen} +${hunkOldStart},${hunkNewLen} @@`);
  for (let i = prefixLen - ctxBefore; i < prefixLen; i++) lines.push(` ${oldLines[i]}`);
  for (const l of oldChanged) lines.push(`-${l}`);
  for (const l of newChanged) lines.push(`+${l}`);
  for (let i = oldLines.length - suffixLen; i < oldLines.length - suffixLen + ctxAfter; i++)
    lines.push(` ${oldLines[i]}`);

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Wrapper component                                                         */
/* -------------------------------------------------------------------------- */

function DiffViewerWrapper({
  oldValue,
  newValue,
  splitView = false,
  viewMode,
  showMinimap = false,
  wordWrap = false,
  codeFolding = true,
}: {
  oldValue: string;
  newValue: string;
  splitView?: boolean;
  viewMode?: 'unified' | 'split' | 'three-pane';
  showMinimap?: boolean;
  wordWrap?: boolean;
  codeFolding?: boolean;
}) {
  const unifiedDiff = computeUnifiedDiff(oldValue, newValue);
  return (
    <div className="border-border overflow-hidden rounded-md border" style={{ height: 400 }}>
      <VirtualDiff
        unifiedDiff={unifiedDiff}
        splitView={splitView}
        viewMode={viewMode}
        filePath="example.tsx"
        codeFolding={codeFolding}
        showMinimap={showMinimap}
        wordWrap={wordWrap}
        className="h-full"
        data-testid="story-diff-viewer"
      />
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
  args: { oldValue: OLD_SIMPLE, newValue: NEW_SIMPLE, splitView: false },
};

export const SplitSimple: Story = {
  name: 'Split — Simple Edit',
  args: { oldValue: OLD_SIMPLE, newValue: NEW_SIMPLE, splitView: true },
};

export const UnifiedMultiline: Story = {
  name: 'Unified — Multi-line Refactor',
  args: { oldValue: OLD_MULTILINE, newValue: NEW_MULTILINE, splitView: false },
};

export const SplitMultiline: Story = {
  name: 'Split — Multi-line Refactor',
  args: { oldValue: OLD_MULTILINE, newValue: NEW_MULTILINE, splitView: true },
};

export const AdditionsOnly: Story = {
  name: 'Additions Only',
  args: { oldValue: OLD_ADDITIONS_ONLY, newValue: NEW_ADDITIONS_ONLY, splitView: false },
};

export const DeletionsOnly: Story = {
  name: 'Deletions Only',
  args: { oldValue: OLD_DELETIONS_ONLY, newValue: NEW_DELETIONS_ONLY, splitView: false },
};

export const NoChanges: Story = {
  name: 'No Changes',
  args: { oldValue: OLD_SIMPLE, newValue: OLD_SIMPLE, splitView: false },
};

export const ThreePane: Story = {
  name: 'Three-pane View',
  args: { oldValue: OLD_MULTILINE, newValue: NEW_MULTILINE, viewMode: 'three-pane' },
};

export const WithMinimap: Story = {
  name: 'With Minimap',
  args: {
    oldValue: OLD_MULTILINE,
    newValue: NEW_MULTILINE,
    splitView: false,
    showMinimap: true,
    codeFolding: false,
  },
};

export const WithWordWrap: Story = {
  name: 'Word Wrap Enabled',
  args: { oldValue: OLD_MULTILINE, newValue: NEW_MULTILINE, splitView: false, wordWrap: true },
};

export const ThreePaneWordWrap: Story = {
  name: 'Three-pane + Word Wrap',
  args: {
    oldValue: OLD_MULTILINE,
    newValue: NEW_MULTILINE,
    viewMode: 'three-pane',
    wordWrap: true,
  },
};
