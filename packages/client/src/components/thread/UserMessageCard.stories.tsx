import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import '@/i18n/config';
import { UserMessageCard } from './UserMessageCard';

const meta = {
  title: 'Thread/UserMessageCard',
  component: UserMessageCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[640px] min-w-0">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UserMessageCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// ── Stories ──────────────────────────────────────────────────────

/** Simple short prompt. */
export const Default: Story = {
  args: {
    content: 'add a user card component to storybook',
    model: 'sonnet',
    permissionMode: 'autoEdit',
    timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
    onClick: fn(),
  },
};

/** Prompt with model and permission mode badges. */
export const WithBadges: Story = {
  args: {
    content: 'refactor the authentication module to use JWT tokens with refresh rotation',
    model: 'opus',
    permissionMode: 'confirmEdit',
    timestamp: new Date(Date.now() - 12 * 60_000).toISOString(),
    onClick: fn(),
  },
};

/** Prompt referencing files — shows file/folder chips above the content. */
export const WithReferencedFiles: Story = {
  args: {
    content: `<referenced-files>
<file path="src/components/Sidebar.tsx" />
<file path="src/stores/app-store.ts" />
<folder path="src/components/ui">
  <file path="src/components/ui/button.tsx" />
  <file path="src/components/ui/dialog.tsx" />
</folder>
</referenced-files>
@src/components/Sidebar.tsx @src/stores/app-store.ts can you refactor the sidebar to use the new store pattern?`,
    model: 'sonnet',
    timestamp: new Date(Date.now() - 3 * 60_000).toISOString(),
    onClick: fn(),
  },
};

/** Long prompt that gets collapsed with a "Show more" button. */
export const LongContent: Story = {
  args: {
    content: `I need you to refactor the entire authentication system. Here are the requirements:

1. Replace the current session-based auth with JWT tokens
2. Implement refresh token rotation with a 7-day expiry
3. Add CSRF protection across all API endpoints
4. Migrate all existing sessions to the new token format
5. Update the client-side auth store to handle token refresh
6. Add rate limiting to the login endpoint (max 5 attempts per minute)
7. Implement account lockout after 10 failed attempts
8. Add audit logging for all auth events
9. Update the middleware to validate tokens on every request
10. Add support for API keys as an alternative auth method

Please make sure all existing tests still pass and add new tests for the token rotation logic. The migration should be backwards-compatible so existing sessions continue to work during the transition period.

Also update the documentation to reflect the new auth flow and add examples for using API keys.`,
    model: 'opus',
    permissionMode: 'autoEdit',
    timestamp: new Date(Date.now() - 30 * 60_000).toISOString(),
    onClick: fn(),
  },
};

/** Prompt without any metadata (no model, no permission mode, no timestamp). */
export const Minimal: Story = {
  args: {
    content: 'fix the login bug',
  },
};

/** Follow-up message in a conversation. */
export const FollowUp: Story = {
  args: {
    content:
      'looks good but can you also add error handling for the edge case when the token is expired?',
    model: 'sonnet',
    timestamp: new Date(Date.now() - 1 * 60_000).toISOString(),
    onClick: fn(),
  },
};

/** Prompt with Haiku model badge. */
export const HaikuModel: Story = {
  args: {
    content: 'quick fix: update the README with the new installation steps',
    model: 'haiku',
    permissionMode: 'autoEdit',
    timestamp: new Date(Date.now() - 45 * 60_000).toISOString(),
    onClick: fn(),
  },
};

/** Spanish language prompt. */
export const SpanishPrompt: Story = {
  args: {
    content:
      'cuando estoy haciendo un commit desde la UI, el boton de push no aparece despues de hacer el commit. Puedes revisar el flujo?',
    model: 'sonnet',
    permissionMode: 'autoEdit',
    timestamp: new Date(Date.now() - 57 * 60_000).toISOString(),
    onClick: fn(),
  },
};

/** Slash command rendered as a pill, both at start and inline. */
export const WithSlashCommand: Story = {
  args: {
    content:
      'vamos a usar /skill-creator:skill-creator porq el resultado de la presentacon fue terrible',
    model: 'opus',
    permissionMode: 'autoEdit',
    timestamp: new Date().toISOString(),
    onClick: fn(),
  },
};

/** Filesystem paths must NOT render as slash-command chips. */
export const WithFilesystemPath: Story = {
  args: {
    content:
      'puedes procesar todas las facturas de cloudflare en /home/argenisleon/Downloads/cloudflare y crear un excel',
    model: 'opus',
    permissionMode: 'autoEdit',
    timestamp: new Date().toISOString(),
    onClick: fn(),
  },
};

/** Code snippet in the prompt. */
export const WithCodeSnippet: Story = {
  args: {
    content: `the following function throws when the array is empty, can you fix it?

function getAverage(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}`,
    model: 'sonnet',
    permissionMode: 'confirmEdit',
    timestamp: new Date(Date.now() - 8 * 60_000).toISOString(),
    onClick: fn(),
  },
};
