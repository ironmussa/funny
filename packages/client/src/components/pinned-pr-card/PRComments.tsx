import type { PRIssueComment, PRReview, PRThreadComment } from '@funny/shared';
import { Loader2, Pencil, Trash2 } from 'lucide-react';

import { AuthorBadge } from '@/components/AuthorBadge';
import { MarkdownBody } from '@/components/MarkdownBody';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { EditForm } from './EditForm';
import { isOwnComment, timeAgo } from './pr-card-helpers';
import { ReactionBar } from './ReactionBar';
import type { PRCommentActions } from './use-pr-comment-actions';

interface EditableCommentProps {
  kind: 'review' | 'issue';
  c: PRThreadComment | PRIssueComment;
  testPrefix: string;
  now: number;
  currentUserLogin: string | undefined;
  actions: PRCommentActions;
}

/** A comment's header (author, age, association, own-comment actions) and its body or edit form. */
export function EditableComment({
  kind,
  c,
  testPrefix,
  now,
  currentUserLogin,
  actions,
}: EditableCommentProps) {
  const { editingId, setEditingId, savingEditId, deletingId, handleEditSave, handleDelete } =
    actions;
  const editKey = `${kind}-${c.id}`;
  const isEditing = editingId === editKey;
  return (
    <>
      <div className="flex items-center gap-1.5 text-xs">
        <AuthorBadge name={c.author} avatarUrl={c.author_avatar_url} size="xs" />
        <span className="text-muted-foreground">{timeAgo(c.created_at, now)}</span>
        {c.author_association && c.author_association !== 'NONE' && (
          <Badge size="xxs" variant="outline">
            {c.author_association}
          </Badge>
        )}
        <div className="flex-1" />
        {isOwnComment(c.author, currentUserLogin) && !isEditing && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setEditingId(editKey)}
                  data-testid={`${testPrefix}-edit-${c.id}`}
                >
                  <Pencil className="icon-xs" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Edit</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={deletingId === editKey}
                  onClick={() => handleDelete(kind, c.id, editKey)}
                  data-testid={`${testPrefix}-delete-${c.id}`}
                >
                  {deletingId === editKey ? (
                    <Loader2 className="icon-xs animate-spin" />
                  ) : (
                    <Trash2 className="icon-xs" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Delete</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
      {isEditing ? (
        <EditForm
          initial={c.body}
          saving={savingEditId === editKey}
          onCancel={() => setEditingId(null)}
          onSave={(body) => handleEditSave(kind, c.id, body, editKey)}
          testId={`${testPrefix}-edit-form-${c.id}`}
        />
      ) : (
        <MarkdownBody body={c.body} />
      )}
    </>
  );
}

interface IssueCommentCardProps extends Omit<EditableCommentProps, 'kind' | 'testPrefix' | 'c'> {
  c: PRIssueComment;
}

/** A conversation (issue) comment with its reactions. */
export function IssueCommentCard(props: IssueCommentCardProps) {
  const { c, actions } = props;
  return (
    <div
      className="border-border bg-background flex flex-col gap-1.5 rounded-md border p-2"
      data-testid={`pinned-pr-comment-${c.id}`}
    >
      <EditableComment {...props} kind="issue" testPrefix="pinned-pr-comment" />
      <ReactionBar
        reactions={c.reactions}
        onReact={(k) => actions.handleReact('issue', c.id, k)}
        testIdBase={`pinned-pr-comment-${c.id}`}
      />
    </div>
  );
}

const REVIEW_STATE_BADGE: Record<
  PRReview['state'],
  { label: string; variant: 'success' | 'error' | 'secondary' }
> = {
  APPROVED: { label: 'Approved', variant: 'success' },
  CHANGES_REQUESTED: { label: 'Changes requested', variant: 'error' },
  COMMENTED: { label: 'Commented', variant: 'secondary' },
  DISMISSED: { label: 'Dismissed', variant: 'secondary' },
  PENDING: { label: 'Pending', variant: 'secondary' },
};

/** A submitted review: author, state badge, age and body. */
export function ReviewCard({ rv, now }: { rv: PRReview; now: number }) {
  const s = REVIEW_STATE_BADGE[rv.state];
  return (
    <div
      className="border-border bg-background flex flex-col gap-1.5 rounded-md border p-2"
      data-testid={`pinned-pr-review-${rv.id}`}
    >
      <div className="flex items-center gap-1.5 text-xs">
        <AuthorBadge name={rv.author} avatarUrl={rv.author_avatar_url} size="xs" />
        <Badge variant={s.variant} size="xxs">
          {s.label}
        </Badge>
        <span className="text-muted-foreground">{timeAgo(rv.submitted_at, now)}</span>
      </div>
      {rv.body && <MarkdownBody body={rv.body} />}
    </div>
  );
}
