import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import '@/i18n/config';

import { PermissionApprovalCard, WaitingActions } from './WaitingCards';

const meta = {
  title: 'Thread/PermissionApprovalCard',
  component: PermissionApprovalCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[640px] min-w-0">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PermissionApprovalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const SHORT_INPUT = JSON.stringify(
  { file_path: '/home/user/notes.txt', content: 'Hello world' },
  null,
  2,
);

const LONG_INPUT = JSON.stringify(
  {
    file_path: '/home/argenisleon/.claude/skills/reverse-text/SKILL.md',
    content: `---
name: reverse-text
description: Reverses any text the user provides, character by character. Use this skill whenever the user asks to reverse, flip, or invert a string of text — including phrases like "reverse this", "flip this text", "invert this string", "what does X look like backwards", or shows a piece of text and asks for its mirror image.
---

# Reverse Text Skill

When the user asks to reverse text, take the input string and return it
character by character in reverse order. Preserve whitespace and punctuation
exactly as provided.

## Examples

- Input: "hello" → Output: "olleh"
- Input: "Claude Code" → Output: "edoC edualC"
- Input: "12345" → Output: "54321"
`,
  },
  null,
  2,
);

/** Default — short tool input, all three actions visible. */
export const Default: Story = {
  args: {
    toolName: 'Write',
    toolInput: SHORT_INPUT,
    onApprove: fn(),
    onAlwaysAllow: fn(),
    onDeny: fn(),
  },
};

/** Long tool input that gets truncated with a "Show more" toggle. */
export const LongInput: Story = {
  args: {
    toolName: 'Write',
    toolInput: LONG_INPUT,
    onApprove: fn(),
    onAlwaysAllow: fn(),
    onDeny: fn(),
  },
};

/** Bash tool — command is extracted from JSON and highlighted as bash. */
export const BashCommand: Story = {
  args: {
    toolName: 'Bash',
    toolInput: JSON.stringify(
      {
        command: 'git log --oneline -n 20 && echo "done" | grep -v WIP || exit 1',
        description: 'Show recent commits',
      },
      null,
      2,
    ),
    onApprove: fn(),
    onAlwaysAllow: fn(),
    onDeny: fn(),
  },
};

/** No "Always allow" button — only single-use approval and deny. */
export const WithoutAlwaysAllow: Story = {
  args: {
    toolName: 'Bash',
    toolInput: JSON.stringify({ command: 'rm -rf node_modules' }, null, 2),
    onApprove: fn(),
    onDeny: fn(),
  },
};

/** No tool input payload — just the prompt and actions. */
export const NoToolInput: Story = {
  args: {
    toolName: 'Read',
    onApprove: fn(),
    onAlwaysAllow: fn(),
    onDeny: fn(),
  },
};

/** Companion: WaitingActions card (Continue / Reject / freeform input). */
export const WaitingActionsCard: StoryObj<typeof WaitingActions> = {
  render: (args) => <WaitingActions {...args} />,
  args: {
    onSend: fn(),
  },
};
