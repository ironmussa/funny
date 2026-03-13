import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import '@/i18n/config';
import { ExitPlanModeCard } from './ExitPlanModeCard';

/* -------------------------------------------------------------------------- */
/*  Interactive wrapper                                                        */
/* -------------------------------------------------------------------------- */

function InteractiveWrapper({ plan }: { plan?: string }) {
  const [output, setOutput] = useState<string | undefined>(undefined);

  return (
    <div className="space-y-3">
      <ExitPlanModeCard
        plan={plan}
        onRespond={(answer) => {
          setOutput(answer);
          // eslint-disable-next-line no-console -- storybook demo
        }}
        output={output}
      />
      {output && (
        <div className="rounded-md border border-border/40 bg-muted/30 p-3">
          <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Response</div>
          <pre className="whitespace-pre-wrap text-xs text-foreground">{output}</pre>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Meta                                                                       */
/* -------------------------------------------------------------------------- */

const meta = {
  title: 'ToolCards/ExitPlanModeCard',
  component: ExitPlanModeCard,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof ExitPlanModeCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const SAMPLE_PLAN = `## Refactor Auth Middleware

### Changes
1. Extract token validation into a shared utility
2. Add session cookie support alongside bearer tokens
3. Update tests to cover both auth paths

### Impact
- No breaking changes for existing API consumers
- New cookie auth will be opt-in via \`AUTH_MODE=multi\``;

/* -------------------------------------------------------------------------- */
/*  Stories                                                                     */
/* -------------------------------------------------------------------------- */

/** Interactive plan review — accept, reject, or provide custom feedback */
export const Interactive: Story = {
  name: 'Interactive — Waiting for Response',
  args: { plan: SAMPLE_PLAN },
  render: () => <InteractiveWrapper plan={SAMPLE_PLAN} />,
};

/** Plan accepted */
export const Accepted: Story = {
  name: 'Answered — Accepted',
  args: {
    plan: SAMPLE_PLAN,
    output: 'Plan accepted',
  },
};

/** Plan rejected */
export const Rejected: Story = {
  name: 'Answered — Rejected',
  args: {
    plan: SAMPLE_PLAN,
    output: 'Plan rejected. Do not proceed with this plan.',
  },
};

/** Custom feedback response */
export const CustomFeedback: Story = {
  name: 'Answered — Custom Feedback',
  args: {
    plan: SAMPLE_PLAN,
    output: 'Looks good but please also add rate limiting to the auth endpoints.',
  },
};

/** Without a plan body (just the action buttons) */
export const NoPlanBody: Story = {
  name: 'No Plan Body',
  args: {},
  render: () => <InteractiveWrapper />,
};
