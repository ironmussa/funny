import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import {
  AttachmentChip,
  FileChip,
  SkillChip,
  SymbolChip,
  type ChipVariant,
} from '@/components/ui/chip';

const VARIANTS: ChipVariant[] = ['default', 'inverse'];

const meta = {
  title: 'UI/Chip',
  component: SkillChip,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    variant: { control: 'select', options: VARIANTS },
  },
} satisfies Meta<typeof SkillChip>;

export default meta;
type SkillStory = StoryObj<typeof meta>;

// ── SkillChip ────────────────────────────────────────────────────

export const Skill: SkillStory = {
  args: { name: 'query-logs' },
};

export const SkillInverse: SkillStory = {
  args: { name: 'query-logs', variant: 'inverse' },
  decorators: [
    (Story) => (
      <div className="rounded-lg bg-foreground p-4">
        <Story />
      </div>
    ),
  ],
};

export const SkillNamespaced: SkillStory = {
  args: { name: 'skill-creator:skill-creator' },
};

// ── FileChip ─────────────────────────────────────────────────────

export const File: StoryObj<typeof FileChip> = {
  render: (args) => <FileChip {...args} />,
  args: { name: 'app-store.ts', type: 'file', title: 'src/stores/app-store.ts' },
};

export const Folder: StoryObj<typeof FileChip> = {
  render: (args) => <FileChip {...args} />,
  args: { name: 'components', type: 'folder', title: 'src/components' },
};

export const FileInverse: StoryObj<typeof FileChip> = {
  render: (args) => (
    <div className="rounded-lg bg-foreground p-4">
      <FileChip {...args} />
    </div>
  ),
  args: {
    name: 'app-store.ts',
    type: 'file',
    title: 'src/stores/app-store.ts',
    variant: 'inverse',
  },
};

// ── SymbolChip ───────────────────────────────────────────────────

export const Symbol: StoryObj<typeof SymbolChip> = {
  render: (args) => <SymbolChip {...args} />,
  args: { name: 'parseReferencedFiles' },
};

// ── AttachmentChip ───────────────────────────────────────────────

export const Attachment: StoryObj<typeof AttachmentChip> = {
  render: (args) => <AttachmentChip {...args} />,
  args: {
    name: 'design-spec.md',
    size: '12 KB',
    onRemove: fn(),
  },
};

export const AttachmentLoading: StoryObj<typeof AttachmentChip> = {
  render: (args) => <AttachmentChip {...args} />,
  args: {
    name: 'large-dataset.csv',
    size: '4.2 MB',
    loading: true,
    onRemove: fn(),
    removeDisabled: true,
  },
};

export const AttachmentReadonly: StoryObj<typeof AttachmentChip> = {
  render: (args) => <AttachmentChip {...args} />,
  args: { name: 'README.md', size: '3 KB' },
};

export const AttachmentInverse: StoryObj<typeof AttachmentChip> = {
  render: (args) => (
    <div className="rounded-lg bg-foreground p-4">
      <AttachmentChip {...args} />
    </div>
  ),
  args: {
    name: 'design-spec.md',
    size: '12 KB',
    onRemove: fn(),
    variant: 'inverse',
  },
};

// ── Side-by-side gallery ─────────────────────────────────────────

export const Gallery: StoryObj = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold">Default variant (light surface)</h3>
        <div className="flex flex-wrap items-center gap-2 rounded border p-4">
          <SkillChip name="query-logs" />
          <FileChip name="app-store.ts" type="file" title="src/stores/app-store.ts" />
          <FileChip name="components" type="folder" title="src/components" />
          <SymbolChip name="parseReferencedFiles" />
          <AttachmentChip name="design-spec.md" size="12 KB" onRemove={fn()} />
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Inverse variant (dark surface)</h3>
        <div className="flex flex-wrap items-center gap-2 rounded bg-foreground p-4">
          <SkillChip name="query-logs" variant="inverse" />
          <FileChip
            name="app-store.ts"
            type="file"
            title="src/stores/app-store.ts"
            variant="inverse"
          />
          <FileChip name="components" type="folder" title="src/components" variant="inverse" />
          <SymbolChip name="parseReferencedFiles" variant="inverse" />
          <AttachmentChip name="design-spec.md" size="12 KB" onRemove={fn()} variant="inverse" />
        </div>
      </section>
    </div>
  ),
};
