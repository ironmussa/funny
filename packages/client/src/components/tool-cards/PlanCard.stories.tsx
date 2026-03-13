import type { Meta, StoryObj } from '@storybook/react-vite';

import '@/i18n/config';
import { PlanCard } from './PlanCard';

const meta = {
  title: 'ToolCards/PlanCard',
  component: PlanCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof PlanCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Simple plan with a few steps */
export const SimplePlan: Story = {
  name: 'Simple Plan',
  args: {
    parsed: {
      plan: `## Implementation Plan

1. Add the new \`validateEmail\` utility function
2. Update the registration route to use validation
3. Add unit tests for the validator`,
    },
  },
};

/** Detailed plan with multiple sections */
export const DetailedPlan: Story = {
  name: 'Detailed Plan',
  args: {
    parsed: {
      plan: `## Authentication Refactor

### Phase 1: Database Schema
- Add \`sessions\` table with TTL column
- Migrate existing tokens to new schema
- Add index on \`expires_at\` for cleanup queries

### Phase 2: Middleware
- Replace bearer token check with session cookie validation
- Add CSRF protection via double-submit cookie pattern
- Implement session refresh on activity

### Phase 3: Client Updates
- Update \`auth-store.ts\` to use cookie-based flow
- Remove token storage from localStorage
- Add automatic redirect on 401 responses

### Notes
- **Breaking change**: existing API tokens will stop working
- Estimated scope: ~15 files across \`runtime\` and \`client\` packages`,
    },
  },
};

/** Plan with code snippets */
export const PlanWithCode: Story = {
  name: 'Plan with Code',
  args: {
    parsed: {
      plan: `## Add Health Check Endpoint

Add a \`/api/health\` route that returns system status:

\`\`\`typescript
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    uptime: process.uptime(),
    version: pkg.version,
  });
});
\`\`\`

This will be used by the Railway deploy healthcheck.`,
    },
  },
};

/** Without label */
export const HiddenLabel: Story = {
  name: 'Hidden Label',
  args: {
    parsed: {
      plan: `## Quick Fix\n\nJust rename the variable from \`camelCase\` to \`snake_case\`.`,
    },
    hideLabel: true,
  },
};

/** Empty plan (should render nothing) */
export const EmptyPlan: Story = {
  name: 'Empty Plan',
  args: {
    parsed: {},
  },
};
