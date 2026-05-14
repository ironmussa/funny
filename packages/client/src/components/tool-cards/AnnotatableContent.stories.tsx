import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, useCallback } from 'react';

import '@/i18n/config';
import { AnnotatableContent } from './AnnotatableContent';
import type { PlanComment } from './PlanReviewDialog';

const EMPTY_COMMENTS: PlanComment[] = [];

/* -------------------------------------------------------------------------- */
/*  Interactive wrapper                                                        */
/* -------------------------------------------------------------------------- */

function InteractiveWrapper({
  children,
  initialComments = EMPTY_COMMENTS,
}: {
  children: React.ReactNode;
  initialComments?: PlanComment[];
}) {
  const [comments, setComments] = useState<PlanComment[]>(initialComments);

  const onAddComment = useCallback((text: string, comment: string) => {
    setComments((prev) => [...prev, { selectedText: text, comment }]);
  }, []);

  const onAddEmoji = useCallback((text: string, emoji: string) => {
    setComments((prev) => [...prev, { selectedText: text, emoji, comment: '' }]);
  }, []);

  const onRemoveComment = useCallback((index: number) => {
    setComments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <div className="w-[500px]">
      <AnnotatableContent
        className="rounded-md border border-border p-4 pr-14"
        planComments={comments}
        onAddComment={onAddComment}
        onAddEmoji={onAddEmoji}
        onRemoveComment={onRemoveComment}
      >
        {children}
      </AnnotatableContent>

      {comments.length > 0 && (
        <div className="mt-3 rounded-md border border-border/40 bg-muted/30 p-3">
          <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
            Annotations ({comments.length})
          </p>
          {comments.map((c, i) => (
            <div key={i} className="text-xs text-muted-foreground">
              {c.emoji || 'Comment'}: &quot;{c.selectedText.slice(0, 40)}
              {c.selectedText.length > 40 ? '...' : ''}&quot;
              {c.comment && <span className="text-foreground">: {c.comment}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Meta                                                                       */
/* -------------------------------------------------------------------------- */

const meta = {
  title: 'ToolCards/AnnotatableContent',
  component: AnnotatableContent,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof AnnotatableContent>;

export default meta;
type Story = StoryObj<typeof meta>;

const DUMMY_ARGS = {
  children: null as React.ReactNode,
  planComments: [] as PlanComment[],
  onAddComment: () => {},
  onAddEmoji: () => {},
  onRemoveComment: () => {},
};

const SAMPLE_TEXT = (
  <div className="prose prose-xs prose-invert max-w-none">
    <h2>Authentication Refactor</h2>
    <p>
      Extract token validation into a shared utility module. This allows both the middleware and the
      API routes to reuse the same validation logic without duplication.
    </p>
    <h3>Steps</h3>
    <ol>
      <li>
        Create <code>validateToken()</code> in <code>lib/auth.ts</code>
      </li>
      <li>Update middleware to call the shared function</li>
      <li>Add unit tests for edge cases</li>
    </ol>
    <p>
      <strong>Note:</strong> No breaking changes expected. The new cookie-based auth will be opt-in
      via the <code>AUTH_MODE</code> environment variable.
    </p>
  </div>
);

/* -------------------------------------------------------------------------- */
/*  Stories                                                                     */
/* -------------------------------------------------------------------------- */

/** Select text to add emoji reactions or comments */
export const Default: Story = {
  args: DUMMY_ARGS,
  render: () => <InteractiveWrapper>{SAMPLE_TEXT}</InteractiveWrapper>,
};

/** Pre-populated with annotations and margin indicators */
export const WithAnnotations: Story = {
  args: DUMMY_ARGS,
  render: () => (
    <InteractiveWrapper
      initialComments={[
        { selectedText: 'Extract token validation', emoji: '\u{2705}', comment: '' },
        { selectedText: 'No breaking changes expected', comment: 'Double-check with the team' },
      ]}
    >
      {SAMPLE_TEXT}
    </InteractiveWrapper>
  ),
};

function DisabledStory() {
  const [comments] = useState<PlanComment[]>([]);
  return (
    <div className="w-[500px]">
      <AnnotatableContent
        className="rounded-md border border-border p-4 pr-14 opacity-60"
        planComments={comments}
        onAddComment={() => {}}
        onAddEmoji={() => {}}
        onRemoveComment={() => {}}
        active={false}
      >
        {SAMPLE_TEXT}
      </AnnotatableContent>
      <p className="mt-2 text-xs text-muted-foreground">Selection is disabled (active=false)</p>
    </div>
  );
}

/** Disabled state — no selection popover appears */
export const Disabled: Story = {
  args: DUMMY_ARGS,
  render: () => <DisabledStory />,
};

/** Plain text content */
export const PlainText: Story = {
  args: DUMMY_ARGS,
  render: () => (
    <InteractiveWrapper>
      <p className="text-sm text-foreground">
        This is a simple paragraph of text. Select any portion to add an emoji reaction or a
        comment. The annotations will appear in the right margin. You can click an annotation icon
        to remove it.
      </p>
    </InteractiveWrapper>
  ),
};
