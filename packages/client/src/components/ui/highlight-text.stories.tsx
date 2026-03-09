import type { Meta, StoryObj } from '@storybook/react-vite';

import { HighlightText } from '@/components/ui/highlight-text';

const meta = {
  title: 'UI/HighlightText',
  component: HighlightText,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof HighlightText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoQuery: Story = {
  args: { text: 'Hello World', query: '' },
};

export const PartialMatch: Story = {
  args: { text: 'Hello World', query: 'World' },
};

export const MultipleMatches: Story = {
  args: { text: 'The quick brown fox jumps over the lazy fox', query: 'fox' },
};

export const CaseInsensitive: Story = {
  args: { text: 'Hello World', query: 'hello' },
};

export const AccentInsensitive: Story = {
  args: { text: 'café résumé naïve', query: 'cafe' },
};

export const NoMatch: Story = {
  args: { text: 'Hello World', query: 'xyz' },
};
