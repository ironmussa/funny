import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';

import { BashCard } from './BashCard';

const meta = {
  title: 'ToolCards/BashCard',
  component: BashCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof BashCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Simple ls command with output */
export const SimpleCommand: Story = {
  name: 'Simple Command',
  args: {
    parsed: { command: 'ls -la' },
    output: `total 48
drwxr-xr-x  12 user user 4096 Mar 10 14:30 .
drwxr-xr-x   5 user user 4096 Mar  9 09:15 ..
-rw-r--r--   1 user user  234 Mar 10 14:30 package.json
-rw-r--r--   1 user user 1205 Mar 10 14:28 tsconfig.json
drwxr-xr-x   3 user user 4096 Mar 10 14:30 src`,
  },
};

/** Multi-line command (piped) */
export const PipedCommand: Story = {
  name: 'Piped Command',
  args: {
    parsed: { command: 'cat package.json | jq ".dependencies" | sort' },
    output: `{
  "@anthropic-ai/claude-agent-sdk": "^0.1.0",
  "hono": "^4.0.0",
  "drizzle-orm": "^0.30.0",
  "neverthrow": "^6.0.0"
}`,
  },
};

/** Command with ANSI color codes in output */
export const AnsiOutput: Story = {
  name: 'ANSI Colored Output',
  args: {
    parsed: { command: 'git status' },
    output: `On branch main
\x1b[32mYour branch is up to date with 'origin/main'.\x1b[0m

Changes not staged for commit:
  \x1b[31mmodified:   src/index.ts\x1b[0m
  \x1b[31mmodified:   src/utils.ts\x1b[0m

Untracked files:
  \x1b[31mnew-file.ts\x1b[0m`,
  },
};

/** Command still running (no output yet) */
export const WaitingForOutput: Story = {
  name: 'Waiting for Output',
  args: {
    parsed: { command: 'bun run build' },
  },
};

/** Command with error output */
export const ErrorOutput: Story = {
  name: 'Error Output',
  args: {
    parsed: { command: 'bun test' },
    output: `\x1b[31m FAIL \x1b[0m src/utils.test.ts
  ● Test suite failed to run

    TypeError: Cannot read property 'map' of undefined

      at Object.<anonymous> (src/utils.test.ts:12:5)

Tests:  1 failed, 1 total
Time:   0.342s`,
  },
};

/** Long command */
export const LongCommand: Story = {
  name: 'Long Command',
  args: {
    parsed: {
      command:
        'find . -name "*.ts" -not -path "*/node_modules/*" -not -path "*/.git/*" | xargs grep -l "TODO" | sort | head -20',
    },
    output: `./src/agent-runner.ts
./src/routes/threads.ts
./src/utils/git-v2.ts`,
  },
};

/** Without label (used inside ToolCallGroup) */
export const HiddenLabel: Story = {
  name: 'Hidden Label',
  args: {
    parsed: { command: 'echo "hello world"' },
    output: 'hello world',
    hideLabel: true,
  },
};

/** Auto-expand the card so the INPUT / OUTPUT sections are visible (it starts collapsed). */
const expand: Story['play'] = async ({ canvasElement, userEvent }) => {
  const { within } = await import('storybook/test');
  await userEvent.click(within(canvasElement).getByRole('button'));
};

// The exact multi-line "Run Command" call from the screenshot — a team-mode
// smoke check still running, so OUTPUT shows the "Waiting for output…" placeholder.
const TEAM_MODE_COMMAND = `cd /home/argenisleon/Git-projects/funny
TMPH=$(mktemp -d)
echo "═══ team mode SIN secret, HOME limpio ⇒ debe exit 1 sin arrancar server ═══"
env -u RUNNER_AUTH_SECRET HOME="$TMPH" TEAM_SERVER_URL=https://example.com timeout 15 bun bin/funny.js 2>&1 | head -15
ec=\${PIPESTATUS[1]}
echo "exit code: $ec"
rm -rf "$TMPH"`;

/** Reproduces the screenshot: multi-line command, expanded, awaiting output. */
export const TeamModeWaiting: Story = {
  name: 'Team-mode Command (waiting, expanded)',
  args: {
    parsed: { command: TEAM_MODE_COMMAND },
    displayTime: '4m',
  },
  play: expand,
};

/** Same command after it finishes — OUTPUT renders the captured stdout/stderr. */
export const TeamModeWithOutput: Story = {
  name: 'Team-mode Command (with output, expanded)',
  args: {
    parsed: { command: TEAM_MODE_COMMAND },
    output:
      '═══ team mode SIN secret, HOME limpio ⇒ debe exit 1 sin arrancar server ═══\n' +
      'error: RUNNER_AUTH_SECRET is required in team mode\n' +
      'exit code: 1',
    displayTime: '4m',
  },
  play: expand,
};
