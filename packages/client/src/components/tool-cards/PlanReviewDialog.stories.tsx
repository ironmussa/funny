import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import '@/i18n/config';
import { PlanReviewDialog, type PlanComment } from './PlanReviewDialog';

/* -------------------------------------------------------------------------- */
/*  Sample plans                                                               */
/* -------------------------------------------------------------------------- */

const SHORT_PLAN = `## Auth Middleware Refactor

### Changes
1. Extract token validation into a shared utility
2. Add session cookie support alongside bearer tokens
3. Update tests to cover both auth paths

### Impact
- No breaking changes for existing API consumers
- New cookie auth will be opt-in via \`AUTH_MODE=multi\``;

const LONG_PLAN = `## Database Migration Plan

### Phase 1: Schema Changes
- Add \`sessions\` table with TTL support
- Migrate \`users.token_hash\` to new \`credentials\` table
- Add composite index on \`(user_id, expires_at)\`

### Phase 2: Data Migration
1. Backfill \`credentials\` from existing \`users\` rows
2. Validate row counts match after migration
3. Run integrity checks on foreign keys

### Phase 3: Code Updates
- Update \`AuthService\` to read from \`credentials\`
- Deprecate \`users.token_hash\` column
- Add feature flag \`USE_NEW_CREDENTIALS=true\`

### Phase 4: Cleanup
- Remove deprecated column after 2-week soak
- Archive migration scripts
- Update documentation

### Rollback Plan
If any phase fails:
1. Revert code changes via feature flag
2. \`credentials\` table can be dropped safely
3. \`users.token_hash\` remains the source of truth until Phase 4`;

/* -------------------------------------------------------------------------- */
/*  Interactive wrapper                                                        */
/* -------------------------------------------------------------------------- */

function PlanReviewTrigger({ plan }: { plan: string }) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<PlanComment[]>([]);

  return (
    <div className="space-y-3">
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="plan-review-trigger">
        Open Plan Review
      </Button>

      {comments.length > 0 && (
        <div className="rounded-md border border-border/40 bg-muted/30 p-3">
          <p className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            Comments ({comments.length})
          </p>
          {comments.map((c, i) => (
            <div key={i} className="mb-1 text-xs text-foreground">
              <span className="font-medium">{c.emoji || 'Comment'}</span>:{' '}
              <span className="text-muted-foreground">
                &quot;{c.selectedText.slice(0, 50)}
                {c.selectedText.length > 50 ? '...' : ''}&quot;
              </span>
              {c.comment && <span>: {c.comment}</span>}
            </div>
          ))}
        </div>
      )}

      <PlanReviewDialog
        open={open}
        onOpenChange={setOpen}
        plan={plan}
        planComments={comments}
        onAddComment={(text, comment) =>
          setComments((prev) => [...prev, { selectedText: text, comment }])
        }
        onAddEmoji={(text, emoji) =>
          setComments((prev) => [...prev, { selectedText: text, emoji, comment: '' }])
        }
        onRemoveComment={(index) => setComments((prev) => prev.filter((_, i) => i !== index))}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Meta                                                                       */
/* -------------------------------------------------------------------------- */

const meta = {
  title: 'Dialogs/PlanReviewDialog',
  component: PlanReviewDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof PlanReviewDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const DUMMY_ARGS = {
  open: false,
  onOpenChange: () => {},
  plan: SHORT_PLAN,
  planComments: [] as PlanComment[],
  onAddComment: () => {},
  onAddEmoji: () => {},
  onRemoveComment: () => {},
};

/* -------------------------------------------------------------------------- */
/*  Stories                                                                     */
/* -------------------------------------------------------------------------- */

/** Short plan — select text to add emoji reactions or comments */
export const Default: Story = {
  args: DUMMY_ARGS,
  render: () => <PlanReviewTrigger plan={SHORT_PLAN} />,
};

/** Long plan with multiple sections — outline sidebar visible */
export const LongPlan: Story = {
  args: DUMMY_ARGS,
  render: () => <PlanReviewTrigger plan={LONG_PLAN} />,
};

function WithCommentsStory() {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<PlanComment[]>([
    { selectedText: 'Extract token validation', emoji: '\u{2705}', comment: '' },
    { selectedText: 'No breaking changes', comment: 'Are we sure about this?' },
    { selectedText: 'session cookie support', emoji: '\u{1F44D}', comment: 'Great idea' },
  ]);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="plan-review-trigger">
        Open with Comments (3)
      </Button>
      <PlanReviewDialog
        open={open}
        onOpenChange={setOpen}
        plan={SHORT_PLAN}
        planComments={comments}
        onAddComment={(text, comment) =>
          setComments((prev) => [...prev, { selectedText: text, comment }])
        }
        onAddEmoji={(text, emoji) =>
          setComments((prev) => [...prev, { selectedText: text, emoji, comment: '' }])
        }
        onRemoveComment={(index) => setComments((prev) => prev.filter((_, i) => i !== index))}
      />
    </>
  );
}

/** Pre-populated with annotations */
export const WithComments: Story = {
  args: DUMMY_ARGS,
  render: () => <WithCommentsStory />,
};
